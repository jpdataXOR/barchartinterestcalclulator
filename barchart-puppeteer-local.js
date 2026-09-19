/**
 * Local Puppeteer script to fetch futures data from Barchart.com
 * 
 * How it works:
 * 1. Launches a headless Chromium browser via Puppeteer
 * 2. Visits barchart.com — this executes the JS challenge and gets the aws-waf-token
 * 3. Extracts all cookies from the browser
 * 4. Uses those cookies to call the Barchart API
 * 5. Saves the data to a JSON file
 * 
 * Usage:
 *   npm install puppeteer
 *   node barchart-puppeteer-local.js
 */

// Target instruments
const TARGET_INSTRUMENTS = [
  'ZC', 'ZS', 'ZL', 'ZW', 'ZO', 'ZR', // Grains
  'CL', 'NG', 'QA', // Energies
  'GC', 'SI', 'HG', 'PL', 'PA', 'AL', // Metals
  'LE', 'HE', // Meats
  'CT', 'KC', 'SB', 'CC', 'LB', 'OJ', // Softs
  'ES', 'NQ', 'ET', 'NM', 'VI', // Indices
  'E6', 'A6', 'B6', 'D6', 'J6', 'S6', 'M6', 'N6', 'L6', 'T6', 'BT', // Currencies
  'ZN', 'ZF', 'ZT' // Interest Rates
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const puppeteer = (await import('puppeteer')).default;

  console.log('=== Barchart Futures Data Fetcher (Puppeteer) ===\n');

  // 1. Launch browser
  console.log('[1] Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process'
    ]
  });

  const page = await browser.newPage();

  // Set a realistic user agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
  );

  // Set extra headers to look like a real browser
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br'
  });

  // 2. Visit barchart.com to trigger the WAF challenge and get cookies
  console.log('[2] Visiting barchart.com to solve WAF challenge...');
  try {
    await page.goto('https://www.barchart.com/futures/major-commodities', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });
    console.log('  ✓ Page loaded successfully');
  } catch (err) {
    console.log('  ⚠ Page load timed out but may still have cookies:', err.message);
  }

  // Wait a bit for any async cookie setting
  await sleep(3000);

  // 3. Extract cookies from the browser
  console.log('\n[3] Extracting cookies...');
  const cookies = await page.cookies();
  console.log(`  Found ${cookies.length} cookies`);

  // Build cookie string and find important ones
  const cookieStrings = [];
  let awsWafToken = '';
  let xsrfToken = '';
  let laravelSession = '';

  for (const cookie of cookies) {
    cookieStrings.push(`${cookie.name}=${cookie.value}`);

    if (cookie.name === 'aws-waf-token') {
      awsWafToken = cookie.value;
      console.log(`  ✓ aws-waf-token: ${cookie.value.substring(0, 40)}...`);
    }
    if (cookie.name === 'XSRF-TOKEN') {
      xsrfToken = cookie.value;
      console.log(`  ✓ XSRF-TOKEN: ${cookie.value.substring(0, 20)}...`);
    }
    if (cookie.name === 'laravel_session') {
      laravelSession = cookie.value;
      console.log(`  ✓ laravel_session: ${cookie.value.substring(0, 20)}...`);
    }
  }

  const cookieHeader = cookieStrings.join('; ');

  if (!awsWafToken) {
    console.log('\n  ✗ No aws-waf-token found! The WAF challenge may not have been solved.');
    console.log('  Trying to wait longer and check again...');
    await sleep(5000);
    const cookies2 = await page.cookies();
    for (const c of cookies2) {
      if (c.name === 'aws-waf-token') {
        awsWafToken = c.value;
        console.log(`  ✓ Found aws-waf-token on retry: ${c.value.substring(0, 40)}...`);
      }
    }
  }

  // 4. Use the browser itself to call the API (token is tied to browser's TLS fingerprint)
  console.log('\n[4] Calling Barchart API from within the browser...');

  const mainUrl = 'https://www.barchart.com/proxies/core-api/v1/quotes/get?lists=futures.category.us.all&fields=symbol%2CcontractName%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2Cvolume%2CtradeTime%2Ccategory%2ChasOptions%2CsymbolCode%2CsymbolType&limit=100&page=1&groupBy=category&raw=1';

  // Execute the API call inside the browser page context
  const data = await page.evaluate(async (url) => {
    const resp = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'referer': 'https://www.barchart.com/futures/major-commodities'
      }
    });
    if (!resp.ok) throw new Error(`API returned ${resp.status}`);
    return resp.json();
  }, mainUrl);

  console.log('  ✓ API call successful!');

  // 5. Process the data
  console.log('\n[5] Processing data...');
  const instrumentsToFetch = new Set();
  const futuresData = [];

  for (const category in data.data) {
    const items = data.data[category];
    for (const item of items) {
      const raw = item.raw;
      const rootSymbol = raw.symbol.match(/^([A-Z0-9]{2})/)?.[1];

      if (rootSymbol && TARGET_INSTRUMENTS.includes(rootSymbol)) {
        instrumentsToFetch.add(rootSymbol);
        futuresData.push({
          symbol: raw.symbol,
          contractName: raw.contractName,
          lastPrice: raw.lastPrice,
          priceChange: raw.priceChange,
          openPrice: raw.openPrice,
          highPrice: raw.highPrice,
          lowPrice: raw.lowPrice,
          volume: raw.volume,
          tradeTime: raw.tradeTime,
          category: raw.category,
          rootSymbol
        });
      }
    }
  }

  console.log(`  Found ${futuresData.length} matching contracts across ${instrumentsToFetch.size} instruments`);

  // 6. Fetch contract details for each instrument (inside browser)
  console.log('\n[6] Fetching contract details...');
  const allContracts = [];

  for (const rootSymbol of instrumentsToFetch) {
    await sleep(500); // Rate limiting

    const detailUrl = `https://www.barchart.com/proxies/core-api/v1/quotes/get?fields=symbol%2CcontractSymbol%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2CpreviousPrice%2Cvolume%2CopenInterest%2CtradeTime%2CsymbolCode%2CsymbolType%2ChasOptions&lists=futures.contractInRoot&root=${rootSymbol}&meta=field.shortName%2Cfield.type%2Cfield.description%2Clists.lastUpdate&hasOptions=true&page=1&limit=100&raw=1`;
    const refererUrl = `https://www.barchart.com/futures/quotes/${rootSymbol}*0/futures-prices`;

    try {
      const detailData = await page.evaluate(async ({ url, referer }) => {
        const resp = await fetch(url, {
          headers: {
            'accept': 'application/json',
            'referer': referer
          }
        });
        if (!resp.ok) return null;
        return resp.json();
      }, { url: detailUrl, referer: refererUrl });

      if (detailData && detailData.data && detailData.data.length > 0) {
        for (const contract of detailData.data) {
          const raw = contract.raw;
          allContracts.push({
            rootSymbol,
            symbol: raw.symbol,
            contractSymbol: raw.contractSymbol,
            lastPrice: raw.lastPrice,
            priceChange: raw.priceChange,
            openPrice: raw.openPrice,
            highPrice: raw.highPrice,
            lowPrice: raw.lowPrice,
            previousPrice: raw.previousPrice,
            volume: raw.volume,
            openInterest: raw.openInterest,
            tradeTime: raw.tradeTime
          });
        }
        console.log(`  ✓ ${rootSymbol}: ${detailData.data.length} contracts`);
      } else {
        console.log(`  ✗ ${rootSymbol}: no data`);
      }
    } catch (err) {
      console.log(`  ✗ ${rootSymbol}: ${err.message}`);
    }
  }

  // 7. Close the browser
  console.log('\n[7] Closing browser...');
  await browser.close();

  // 8. Save to file
  const output = {
    fetchedAt: new Date().toISOString(),
    instruments: Array.from(instrumentsToFetch),
    futuresData,
    allContracts,
    stats: {
      totalContracts: futuresData.length,
      totalInstruments: instrumentsToFetch.size,
      totalContractDetails: allContracts.length
    }
  };

  const { writeFileSync } = await import('fs');
  writeFileSync('barchart-data.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ Data saved to barchart-data.json`);
  console.log(`  Instruments: ${output.stats.totalInstruments}`);
  console.log(`  Contracts: ${output.stats.totalContracts}`);
  console.log(`  Contract Details: ${output.stats.totalContractDetails}`);
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});