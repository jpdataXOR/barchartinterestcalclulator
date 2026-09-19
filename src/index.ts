/**
 * Cloudflare Worker — Barchart Futures Data Fetcher
 * Uses @cloudflare/puppeteer for browser automation
 *
 * Endpoints:
 *   GET /api/refresh  — Fetch fresh data from Barchart
 *   GET /api/data     — Return the last fetched data
 *   GET /             — HTML dashboard
 */

import puppeteer from "@cloudflare/puppeteer";
import { renderHtml } from "./renderHtml";

interface Env {
  MYBROWSER: Fetcher;
  FUTURES_DATA: KVNamespace;
}

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

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/refresh') {
      return handleRefresh(env);
    }

    if (url.pathname === '/api/data') {
      return handleGetData(env);
    }

    return new Response(renderHtml(), {
      headers: { 'Content-Type': 'text/html' }
    });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log('Scheduled refresh started');
    await fetchAndStoreData(env);
    console.log('Scheduled refresh completed');
  }
};

/**
 * Main function: visit barchart.com, get WAF token, fetch data
 */
async function fetchAndStoreData(env: Env) {
  console.log('Connecting to browser...');
  const browser = await puppeteer.launch(env.MYBROWSER);

  try {
    // Create a page
    console.log('Creating page...');
    const page = await browser.newPage();
    
    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set realistic user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    );

    // Navigate to barchart
    console.log('Navigating to barchart.com...');
    try {
      await page.goto('https://www.barchart.com/futures/major-commodities', {
        waitUntil: 'networkidle0',
        timeout: 60000
      });
      console.log('  Page loaded successfully');
    } catch (err: any) {
      console.log('  Navigation timeout but may still have cookies:', err.message);
    }

    // Wait for any async cookie setting
    await sleep(3000);

    // Get cookies
    console.log('Getting cookies...');
    const cookies = await page.cookies();
    console.log(`Found ${cookies.length} cookies`);

    let awsWafToken = '';
    for (const cookie of cookies) {
      if (cookie.name === 'aws-waf-token') {
        awsWafToken = cookie.value;
        console.log('aws-waf-token found!');
      }
    }

    if (!awsWafToken) {
      console.log('No aws-waf-token found, waiting longer...');
      await sleep(5000);
      const cookies2 = await page.cookies();
      for (const c of cookies2) {
        if (c.name === 'aws-waf-token') {
          awsWafToken = c.value;
          console.log('Found aws-waf-token on retry!');
        }
      }
    }

    if (!awsWafToken) {
      throw new Error('No aws-waf-token obtained from barchart.com');
    }

    // Call the API from within the browser
    console.log('Fetching futures data...');
    const mainUrl = 'https://www.barchart.com/proxies/core-api/v1/quotes/get?lists=futures.category.us.all&fields=symbol%2CcontractName%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2Cvolume%2CtradeTime%2Ccategory%2ChasOptions%2CsymbolCode%2CsymbolType&limit=100&page=1&groupBy=category&raw=1';

    const mainData = await page.evaluate(async (url: string) => {
      const resp = await fetch(url, {
        headers: { 
          'accept': 'application/json', 
          'referer': 'https://www.barchart.com/futures/major-commodities' 
        }
      });
      if (!resp.ok) throw new Error('API returned ' + resp.status);
      return resp.json();
    }, mainUrl);

    console.log('API call successful!');

    // Process data
    const instrumentsToFetch = new Set<string>();
    const futuresData: any[] = [];

    for (const category in mainData.data) {
      const items = mainData.data[category];
      for (const item of items) {
        const raw = item.raw;
        const rootSymbol = (raw.symbol as string).match(/^([A-Z0-9]{2})/)?.[1];
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

    console.log(`Found ${futuresData.length} contracts across ${instrumentsToFetch.size} instruments`);

    // Fetch contract details
    const allContracts: any[] = [];
    for (const rootSymbol of instrumentsToFetch) {
      await sleep(500);
      const detailUrl = `https://www.barchart.com/proxies/core-api/v1/quotes/get?fields=symbol%2CcontractSymbol%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2CpreviousPrice%2Cvolume%2CopenInterest%2CtradeTime%2CsymbolCode%2CsymbolType%2ChasOptions&lists=futures.contractInRoot&root=${rootSymbol}&meta=field.shortName%2Cfield.type%2Cfield.description%2Clists.lastUpdate&hasOptions=true&page=1&limit=100&raw=1`;
      const referer = `https://www.barchart.com/futures/quotes/${rootSymbol}*0/futures-prices`;

      try {
        const detailData = await page.evaluate(async ({ url, referer }: { url: string; referer: string }) => {
          const resp = await fetch(url, {
            headers: { 'accept': 'application/json', 'referer': referer }
          });
          if (!resp.ok) return null;
          return resp.json();
        }, { url: detailUrl, referer });

        if (detailData && detailData.data) {
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
          console.log(`  ${rootSymbol}: ${detailData.data.length} contracts`);
        } else {
          console.log(`  ${rootSymbol}: no data`);
        }
      } catch (err: any) {
        console.log(`Error ${rootSymbol}: ${err.message}`);
      }
    }

    // Close browser
    console.log('Closing browser...');
    await browser.close();

    // Store in KV
    const payload = {
      fetchedAt: new Date().toISOString(),
      futuresData,
      allContracts,
      instruments: Array.from(instrumentsToFetch),
      stats: {
        totalContracts: futuresData.length,
        totalInstruments: instrumentsToFetch.size,
        totalContractDetails: allContracts.length
      }
    };

    await env.FUTURES_DATA.put('latest', JSON.stringify(payload));
    await env.FUTURES_DATA.put('lastUpdated', new Date().toISOString());

    console.log('Data stored successfully');
    return { success: true, stats: payload.stats };

  } catch (error: any) {
    console.error('Error:', error.message);
    try { await browser.close(); } catch (e) {}
    throw error;
  }
}

async function handleRefresh(env: Env): Promise<Response> {
  try {
    const result = await fetchAndStoreData(env);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleGetData(env: Env): Promise<Response> {
  try {
    const data = await env.FUTURES_DATA.get('latest', 'json');
    const lastUpdated = await env.FUTURES_DATA.get('lastUpdated');
    if (!data) {
      return new Response(JSON.stringify({ error: 'No data yet. Call /api/refresh first.' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(JSON.stringify(Object.assign({}, data, { lastUpdated })), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
