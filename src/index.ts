/**
 * Cloudflare Worker — Barchart Futures Data Fetcher
 * Uses raw CDP (Chrome DevTools Protocol) via WebSocket — no Puppeteer library needed.
 *
 * Endpoints:
 *   GET /api/refresh  — Fetch fresh data from Barchart
 *   GET /api/data     — Return the last fetched data
 *   GET /             — HTML dashboard
 */

import { renderHtml } from "./renderHtml";

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
 * Send a CDP command over WebSocket and wait for response
 */
function cdpSend(ws: WebSocket, msgId: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ id: msgId, method, params });

    const handler = (event: MessageEvent) => {
      try {
        const resp = JSON.parse(event.data as string);
        if (resp.id === msgId) {
          ws.removeEventListener('message', handler);
          if (resp.error) {
            reject(new Error(resp.error.message));
          } else {
            resolve(resp.result);
          }
        }
      } catch (e) {
        // Ignore parse errors on non-JSON messages
      }
    };

    ws.addEventListener('message', handler);
    ws.send(msg);

    setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`CDP command ${method} timed out`));
    }, 30000);
  });
}

/**
 * Wait for a specific CDP event
 */
function cdpWaitForEvent(ws: WebSocket, eventName: string, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent) => {
      try {
        const resp = JSON.parse(event.data as string);
        if (resp.method === eventName) {
          ws.removeEventListener('message', handler);
          resolve(resp.params);
        }
      } catch (e) { }
    };
    ws.addEventListener('message', handler);
    setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error(`Event ${eventName} timed out`));
    }, timeout);
  });
}

/**
 * Evaluate JavaScript in the browser page and get the result
 */
async function cdpEvaluate(ws: WebSocket, expression: string): Promise<any> {
  const msgId = Date.now();
  const result = await cdpSend(ws, msgId, 'Runtime.evaluate', {
    expression: `(${expression})()`,
    returnByValue: true,
    awaitPromise: true,
    timeout: 30000
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'Evaluation error');
  }

  return result.result.value;
}

/**
 * Main function: uses CDP to control a browser, visit barchart.com,
 * solve the WAF challenge, call the API, and store results in KV
 */
async function fetchAndStoreData(env: Env) {
  console.log('Fetching browser session...');

  // Step 1: Get a browser session from the binding
  const browserRes = await env.MYBROWSER.fetch(new Request('https://browser/'));
  const webSocketUrl = browserRes.headers.get('X-Chrome-WebSocket-URL');

  if (!webSocketUrl) {
    throw new Error('Failed to get browser WebSocket URL');
  }

  console.log('Connecting to browser via WebSocket...');

  // Step 2: Connect via WebSocket
  const ws = new WebSocket(webSocketUrl);

  // Wait for WebSocket to open
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('WebSocket connection error')));
    setTimeout(() => reject(new Error('WebSocket connection timeout')), 15000);
  });

  try {
    // Step 3: Create a new page/target
    console.log('Creating new page...');
    const target = await cdpSend(ws, 1, 'Target.createTarget', {
      url: 'about:blank',
      width: 1920,
      height: 1080
    });
    const pageId = target.targetId as string;

    // Step 4: Navigate to barchart.com
    console.log('Navigating to barchart.com...');
    await cdpSend(ws, 2, 'Page.enable', {});
    await cdpSend(ws, 3, 'Page.navigate', {
      url: 'https://www.barchart.com/futures/major-commodities'
    });

    // Wait for navigation to complete (or timeout — WAF challenge may hang)
    try {
      await cdpWaitForEvent(ws, 'Page.frameStoppedLoading', 30000);
    } catch (e: any) {
      console.log('Navigation timeout (WAF challenge may be pending):', e.message);
    }

    // Wait for cookies to be set
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 5: Get cookies from the browser
    console.log('Getting cookies...');
    const cookieResult = await cdpSend(ws, 4, 'Network.getAllCookies', {});
    const cookies: { name: string; value: string }[] = cookieResult.cookies || [];
    console.log(`Found ${cookies.length} cookies`);

    let awsWafToken = '';
    for (const cookie of cookies) {
      if (cookie.name === 'aws-waf-token') {
        awsWafToken = cookie.value;
        console.log('aws-waf-token found');
      }
    }

    if (!awsWafToken) {
      throw new Error('Failed to obtain aws-waf-token from barchart.com');
    }

    // Step 6: Call the main API from within the browser
    console.log('Fetching futures data...');
    const mainUrl = 'https://www.barchart.com/proxies/core-api/v1/quotes/get?lists=futures.category.us.all&fields=symbol%2CcontractName%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2Cvolume%2CtradeTime%2Ccategory%2ChasOptions%2CsymbolCode%2CsymbolType&limit=100&page=1&groupBy=category&raw=1';

    const mainData = await cdpEvaluate(ws, `async () => {
      const resp = await fetch('${mainUrl}', {
        headers: { 'accept': 'application/json', 'referer': 'https://www.barchart.com/futures/major-commodities' }
      });
      if (!resp.ok) throw new Error('API returned ' + resp.status);
      return resp.json();
    }`);

    console.log('Main API call successful');

    // Step 7: Process and identify target instruments
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

    // Step 8: Fetch contract details for each instrument
    const allContracts: any[] = [];

    for (const rootSymbol of instrumentsToFetch) {
      await new Promise(resolve => setTimeout(resolve, 500));

      const detailUrl = `https://www.barchart.com/proxies/core-api/v1/quotes/get?fields=symbol%2CcontractSymbol%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2CpreviousPrice%2Cvolume%2CopenInterest%2CtradeTime%2CsymbolCode%2CsymbolType%2ChasOptions&lists=futures.contractInRoot&root=${rootSymbol}&meta=field.shortName%2Cfield.type%2Cfield.description%2Clists.lastUpdate&hasOptions=true&page=1&limit=100&raw=1`;
      const referer = `https://www.barchart.com/futures/quotes/${rootSymbol}*0/futures-prices`;

      try {
        const detailData = await cdpEvaluate(ws, `async () => {
          const resp = await fetch('${detailUrl}', {
            headers: { 'accept': 'application/json', 'referer': '${referer}' }
          });
          if (!resp.ok) return null;
          return resp.json();
        }`);

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
        }
      } catch (err: any) {
        console.error(`Error fetching ${rootSymbol}:`, err.message);
      }
    }

    // Step 9: Close the browser target
    console.log('Closing browser...');
    try { await cdpSend(ws, 99, 'Target.closeTarget', { targetId: pageId }); } catch (e) { }
    ws.close();

    // Step 10: Store in KV
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
    try { ws.close(); } catch (e) { }
    throw error;
  }
}

/**
 * Handle manual refresh request
 */
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

/**
 * Return stored data
 */
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

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Futures Analysis</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #eee; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #e94560; }
    .card { background: #16213e; border-radius: 8px; padding: 20px; margin: 10px 0; }
    .btn { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; }
    .btn:hover { background: #c73650; }
    pre { background: #0f3460; padding: 15px; border-radius: 4px; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Futures Analysis</h1>
    <div class="card">
      <p>Uses Cloudflare Browser Run (CDP) to fetch data from Barchart.com</p>
      <button class="btn" onclick="refresh()">Refresh Data</button>
      <button class="btn" style="background:#0f3460" onclick="loadData()">View Data</button>
      <div id="status"></div>
    </div>
    <div class="card">
      <pre id="output">Click "View Data" to see results</pre>
    </div>
  </div>
  <script>
    async function refresh() {
      document.getElementById('status').textContent = 'Refreshing...';
      const r = await fetch('/api/refresh');
      const d = await r.json();
      document.getElementById('status').textContent = d.error || 'Done! ' + JSON.stringify(d.stats);
    }
    async function loadData() {
      const r = await fetch('/api/data');
      const d = await r.json();
      document.getElementById('output').textContent = JSON.stringify(d, null, 2);
    }
  </script>
</body>
</html>`;
}
