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

// ---- Futures contract decoding & roll-yield report generation ----

// Month letter -> month number (CME futures continuation codes)
const MONTH_CODE_TO_NUM = {
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12
};

// Root symbol -> human readable name
const ROOT_NAMES = {
  ZC: 'Corn', ZS: 'Soybean', ZL: 'Soybean Oil', ZW: 'Wheat', ZO: 'Oats', ZR: 'Rough Rice',
  CL: 'Crude Oil WTI', NG: 'Natural Gas', QA: 'Crude Oil Brent',
  GC: 'Gold', SI: 'Silver', HG: 'High Grade Copper', PL: 'Platinum', PA: 'Palladium', AL: 'Aluminum',
  LE: 'Live Cattle', HE: 'Lean Hogs',
  CT: 'Cotton #2', KC: 'Coffee', SB: 'Sugar #11', CC: 'Cocoa', LB: 'Lumber Physical', OJ: 'Orange Juice',
  ES: 'S&P 500 E-Mini', NQ: 'Nasdaq 100 E-Mini', ET: 'S&P 500 Micro', NM: 'Nasdaq 100 Micro', VI: 'S&P 500 VIX',
  E6: 'Euro FX', A6: 'Australian Dollar', B6: 'British Pound', D6: 'Canadian Dollar',
  J6: 'Japanese Yen', S6: 'Swiss Franc', M6: 'Mexican Peso', N6: 'New Zealand Dollar',
  L6: 'Brazilian Real', T6: 'South African Rand', BT: 'Bitcoin Futures',
  ZN: '10-Year T-Note', ZF: '5-Year T-Note', ZT: '2-Year T-Note'
};

// Root symbol -> category
const ROOT_CATEGORIES = {
  ZC: 'Grains', ZS: 'Grains', ZL: 'Grains', ZW: 'Grains', ZO: 'Grains', ZR: 'Grains',
  CL: 'Energies', NG: 'Energies', QA: 'Energies',
  GC: 'Metals', SI: 'Metals', HG: 'Metals', PL: 'Metals', PA: 'Metals', AL: 'Metals',
  LE: 'Meats', HE: 'Meats',
  CT: 'Softs', KC: 'Softs', SB: 'Softs', CC: 'Softs', LB: 'Softs', OJ: 'Softs',
  ES: 'Indices', NQ: 'Indices', ET: 'Indices', NM: 'Indices', VI: 'Indices',
  E6: 'Currencies', A6: 'Currencies', B6: 'Currencies', D6: 'Currencies',
  J6: 'Currencies', S6: 'Currencies', M6: 'Currencies', N6: 'Currencies',
  L6: 'Currencies', T6: 'Currencies', BT: 'Currencies',
  ZN: 'Financials', ZF: 'Financials', ZT: 'Financials'
};

// Root symbol -> dollar value per 1.00 contract price move
// (used for the "Daily $/ctr" column). Approximates exchange point values.
const ROOT_POINT_VALUE = {
  ZC: 50, ZS: 50, ZL: 600, ZW: 50, ZO: 50, ZR: 2000,
  CL: 1000, NG: 10000, QA: 1000,
  GC: 100, SI: 5000, HG: 25000, PL: 50, PA: 100, AL: 250,
  LE: 400, HE: 400,
  CT: 500, KC: 37500, SB: 1120, CC: 10, LB: 110, OJ: 150,
  ES: 50, NQ: 20, ET: 5, NM: 2, VI: 1000,
  E6: 125000, A6: 100000, B6: 62500, D6: 100000,
  J6: 12500000, S6: 125000, M6: 500000, N6: 100000,
  L6: 100000, T6: 250000, BT: 5,
  ZN: 1000, ZF: 1000, ZT: 2000
};

// Parse a futures contract symbol like "ZCZ26" or "ESZ26" into {root, month, year, expiry}
// Symbol = root(letters/2) + monthCode(1 letter) + year(2 digits). Some roots are 1 or 2 letters.
function parseContractSymbol(symbol) {
  // Match: everything up to a single month letter followed by two year digits
  const match = String(symbol).match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{2})$/);
  if (!match) return null;
  const root = match[1];
  const monthNum = MONTH_CODE_TO_NUM[match[2]];
  if (!monthNum) return null;
  const year = 2000 + parseInt(match[3], 10);
  // Approximate delivery mid-month for ordering/days-between calculations
  const expiry = new Date(year, monthNum - 1, 15);
  return { root, monthNum, year, expiry };
}

// Helper to find the nearest & second-nearest expiring contracts from a list
function pickFrontNext(contracts) {
  const valid = contracts
    .filter(c => c.contractSymbol && c.lastPrice != null)
    .map(c => {
      const parsed = parseContractSymbol(c.contractSymbol);
      return parsed ? { ...c, expiry: parsed.expiry } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.expiry - b.expiry);
  if (valid.length < 2) return null;
  // Prefer the two nearest expiries (skip the very front if it's the current month already rolling, keep it simple)
  return { front: valid[0], next: valid[1] };
}

// Compute annualized yield (%) between front & next contract
function annualizedYield(front, next) {
  if (!front || !next || !front.lastPrice) return 0;
  const daysBetween = Math.max(1, Math.round((next.expiry - front.expiry) / 86400000));
  return ((next.lastPrice - front.lastPrice) / front.lastPrice) * (365 / daysBetween) * 100;
}

// Generate a single report row from a root symbol + its contracts
function buildReportRow(root, contracts) {
  const pair = pickFrontNext(contracts);
  if (!pair) return null;
  const { front, next } = pair;
  const diff = front.lastPrice - next.lastPrice;
  const annYield = annualizedYield(front, next);
  const pointValue = ROOT_POINT_VALUE[root] || 1;
  const dailyDollar = Math.abs(diff) * pointValue / 100;

  let curve, signal, signalClass;
  if (Math.abs(diff) / front.lastPrice < 0.0005) {
    curve = 'Flat';
    signal = 'FLAT';
    signalClass = '';
  } else if (diff < 0) {
    // front is lower than next: contango (downward slope = positive for shorts)
    curve = 'Contango';
    signal = 'SHORT';
    signalClass = 'short';
  } else {
    curve = 'Backwardation';
    signal = 'LONG';
    signalClass = 'long';
  }

  return {
    root,
    name: ROOT_NAMES[root] || root,
    category: ROOT_CATEGORIES[root] || 'Other',
    frontSymbol: front.contractSymbol,
    nextSymbol: next.contractSymbol,
    frontPrice: front.lastPrice,
    nextPrice: next.lastPrice,
    diff,
    annYield,
    dailyDollar,
    curve,
    signal,
    signalClass
  };
}

// Escape HTML in strings
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(v, digits = 4) {
  if (v == null || isNaN(v)) return '';
  return Number(v).toFixed(digits);
}

function fmtYield(v) {
  if (v == null || isNaN(v)) return '';
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

function fmtSigned(v, digits = 4) {
  if (v == null || isNaN(v)) return '';
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(digits)}`;
}

// Build the full HTML report
function generateReport(output) {
  const fetchedAt = output.fetchedAt || new Date().toISOString();

  // Group contracts by root symbol
  const byRoot = new Map();
  for (const contract of output.allContracts || []) {
    const root = contract.rootSymbol;
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(contract);
  }

  // Build one row per root instrumentation available
  const rows = [];
  for (const root of Object.keys(ROOT_NAMES)) {
    const contracts = byRoot.get(root);
    if (!contracts || contracts.length === 0) continue;
    const row = buildReportRow(root, contracts);
    if (row) rows.push(row);
  }

  const longRows = rows.filter(r => r.signal === 'LONG');
  const shortRows = rows.filter(r => r.signal === 'SHORT');
  const flatRows = rows.filter(r => r.signal === 'FLAT');

  // Count unique contract months across all detail contracts
  let contractMonthCount = 0;
  for (const arr of byRoot.values()) contractMonthCount += arr.length;

  const headerCols = ['Symbol', 'Name', 'Category', 'Front', 'Next', 'Front $', 'Next $', 'Diff', 'Ann. Yield', 'Daily $/ctr', 'Signal'];

  const renderRow = (r) => `
<tr>
      <td><strong>${esc(r.root)}</strong></td>
      <td>${esc(r.name)}</td>
      <td>${esc(r.category)}</td>
      <td>${esc(r.frontSymbol)}</td>
      <td>${esc(r.nextSymbol)}</td>
      <td>${fmtNum(r.frontPrice)}</td>
      <td>${fmtNum(r.nextPrice)}</td>
      <td class="${r.diff < 0 ? 'positive' : r.diff > 0 ? 'negative' : ''}">${fmtSigned(r.diff)}</td>
      <td class="${r.annYield < 0 ? 'positive' : r.annYield > 0 ? 'negative' : ''}">${fmtYield(r.annYield)}</td>
      <td>$${fmtNum(r.dailyDollar, 2)}</td>
      <td><span class="badge ${r.signalClass ? 'badge-' + r.signalClass : ''}">${r.signal}</span></td>
    </tr>`;

  const renderLongTable = longRows.map(renderRow).join('\n');
  const renderShortTable = shortRows.map(renderRow).join('\n');
  const renderAllTable = rows.map(r => `
<tr>
        <td><strong>${esc(r.root)}</strong></td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.category)}</td>
        <td>${esc(r.frontSymbol)}</td>
        <td>${esc(r.nextSymbol)}</td>
        <td>${fmtNum(r.frontPrice)}</td>
        <td>${fmtNum(r.nextPrice)}</td>
        <td class="${r.diff < 0 ? 'positive' : r.diff > 0 ? 'negative' : ''}">${fmtSigned(r.diff)}</td>
        <td class="${r.annYield < 0 ? 'positive' : r.annYield > 0 ? 'negative' : ''}">${fmtYield(r.annYield)}</td>
        <td><span class="badge ${r.curve === 'Contango' ? 'badge-contango' : r.curve === 'Backwardation' ? 'badge-backwardation' : ''}">${r.curve}</span></td>
        <td><span class="badge ${r.signalClass ? 'badge-' + r.signalClass : ''}">${r.signal}</span></td>
      </tr>`).join('\n');

  const headerAll = ['Symbol', 'Name', 'Category', 'Front', 'Next', 'Front $', 'Next $', 'Diff', 'Ann. Yield', 'Curve', 'Signal'];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Futures Roll Yield Analysis - ${esc(fetchedAt)}</title>
<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://cdn.datatables.net/1.13.4/js/jquery.dataTables.min.js"></script>
<link rel="stylesheet" href="https://cdn.datatables.net/1.13.4/css/jquery.dataTables.min.css">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0d1117; color:#c9d1d9; padding:20px; }
.container { max-width:1400px; margin:0 auto; }
.header { background:linear-gradient(135deg,#1f6feb,#238636); padding:30px; border-radius:12px 12px 0 0; text-align:center; }
.header h1 { font-size:2em; color:#fff; }
.header .ts { color:#ccc; font-size:0.9em; margin-top:8px; }
.stats { display:flex; gap:16px; padding:20px; background:#161b22; border-bottom:1px solid #30363d; flex-wrap:wrap; }
.stat-box { text-align:center; padding:12px 24px; background:#0d1117; border-radius:8px; border:1px solid #30363d; flex:1; min-width:120px; }
.stat-box .num { font-size:1.8em; font-weight:bold; color:#58a6ff; }
.stat-box .label { color:#8b949e; font-size:0.85em; margin-top:4px; }
.tabs { display:flex; background:#161b22; border-bottom:2px solid #30363d; overflow-x:auto; }
.tab { padding:14px 24px; cursor:pointer; border:none; background:transparent; font-size:0.95em; color:#8b949e; transition:all 0.2s; border-bottom:3px solid transparent; white-space:nowrap; }
.tab:hover { background:#0d1117; color:#c9d1d9; }
.tab.active { color:#58a6ff; border-bottom-color:#58a6ff; }
.tab-content { display:none; padding:24px; background:#0d1117; }
.tab-content.active { display:block; }
table { width:100%; border-collapse:collapse; margin-top:16px; }
thead { background:#161b22; }
th { padding:10px 12px; text-align:left; font-weight:600; color:#8b949e; font-size:0.8em; border-bottom:2px solid #30363d; }
td { padding:8px 12px; border-bottom:1px solid #21262d; font-size:0.85em; }
tbody tr:hover { background:#161b22; }
.positive { color:#3fb950; font-weight:bold; }
.negative { color:#f85149; font-weight:bold; }
.badge { display:inline-block; padding:2px 10px; border-radius:10px; font-size:0.75em; font-weight:600; }
.badge-long { background:#0d5320; color:#3fb950; border:1px solid #3fb950; }
.badge-short { background:#5c1010; color:#f85149; border:1px solid #f85149; }
.badge-contango { background:#5c1010; color:#f85149; border:1px solid #f85149; }
.badge-backwardation { background:#0d5320; color:#3fb950; border:1px solid #3fb950; }
.summary-box { background:#161b22; padding:20px; border-radius:8px; margin-top:20px; border:1px solid #30363d; }
.summary-box h3 { color:#58a6ff; margin-bottom:12px; }
.summary-item { display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #21262d; }
.summary-item:last-child { border-bottom:none; }
.dataTables_wrapper .dataTables_filter input { background:#0d1117; border:1px solid #30363d; color:#c9d1d9; border-radius:4px; padding:6px; }
.dataTables_wrapper .dataTables_length select { background:#0d1117; border:1px solid #30363d; color:#c9d1d9; border-radius:4px; }
.dataTables_wrapper .dataTables_info, .dataTables_wrapper .dataTables_paginate { color:#8b949e !important; }
</style>
</head>
<body>
<div class="container">
<div class="header">
  <h1>Futures Roll Yield Analysis</h1>
  <div class="ts">Generated: ${esc(fetchedAt)}</div>
</div>
<div class="stats">
  <div class="stat-box"><div class="num">${rows.length}</div><div class="label">Instruments Analyzed</div></div>
  <div class="stat-box"><div class="num">${longRows.length}</div><div class="label">LONG Opportunities</div></div>
  <div class="stat-box"><div class="num">${shortRows.length}</div><div class="label">SHORT Opportunities</div></div>
  <div class="stat-box"><div class="num">${contractMonthCount}</div><div class="label">Contract Months</div></div>
</div>
<div class="tabs">
  <button class="tab active" data-tab="long">LONG Opportunities (Backwardation)</button>
  <button class="tab" data-tab="short">SHORT Opportunities (Contango)</button>
  <button class="tab" data-tab="all">All Instruments</button>
</div>

<div id="long" class="tab-content active">
  <h2 style="color:#3fb950;margin-bottom:8px;">LONG Opportunities — Backwardation</h2>
  <p style="color:#8b949e;font-size:0.85em;margin-bottom:12px;">
    Front month < next month → futures curve slopes DOWN → roll yield is POSITIVE for longs.
    Higher annualized % = stronger backwardation.
  </p>
  <table id="longTable" class="display">
    <thead><tr>${headerCols.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${renderLongTable}</tbody>
  </table>
</div>

<div id="short" class="tab-content">
  <h2 style="color:#f85149;margin-bottom:8px;">SHORT Opportunities — Contango</h2>
  <p style="color:#8b949e;font-size:0.85em;margin-bottom:12px;">
    Front month < next month → futures curve slopes UP → roll yield is NEGATIVE for longs (positive for shorts).
    Higher annualized % = stronger contango.
  </p>
  <table id="shortTable" class="display">
    <thead><tr>${headerCols.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${renderShortTable}</tbody>
  </table>
</div>

<div id="all" class="tab-content">
  <h2 style="color:#58a6ff;margin-bottom:8px;">All Instruments — Yield Analysis</h2>
  <table id="allTable" class="display">
    <thead><tr>${headerAll.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${renderAllTable}</tbody>
  </table>
</div>

<div class="summary-box" style="margin-top:24px;">
  <h3>How Roll Yield Works</h3>
  <div class="summary-item"><span><strong>Backwardation</strong> (LONG): Front > Next</span><span style="color:#3fb950">Positive roll yield — futures curve slopes down. Roll profits as contracts converge to spot.</span></div>
  <div class="summary-item"><span><strong>Contango</strong> (SHORT): Front < Next</span><span style="color:#f85149">Negative roll yield — futures curve slopes up. Shorts benefit as contracts converge to spot.</span></div>
  <div class="summary-item"><span><strong>Annualized Yield</strong></span><span style="color:#8b949e">The annualized percentage return from rolling futures positions, based on front-to-next spread.</span></div>
  <div class="summary-item"><span><strong>Daily $/contract</strong></span><span style="color:#8b949e">Dollar value of the daily basis change per contract (using standard point values).</span></div>
</div>
</div>

<script>
$(document).ready(function() {
  $('#longTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });
  $('#shortTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });
  $('#allTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });

  $('.tab').click(function() {
    $('.tab').removeClass('active');
    $('.tab-content').removeClass('active');
    $(this).addClass('active');
    $('#' + $(this).data('tab')).addClass('active');
  });
});
</script>
</body>
</html>`;
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

  // 9. Auto-generate the roll-yield HTML report
  console.log('\n[9] Generating roll-yield report...');
  const reportHtml = generateReport(output);
  writeFileSync('futures_roll_yield_report.html', reportHtml);
  console.log('  ✓ Report saved to futures_roll_yield_report.html');
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});