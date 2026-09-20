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

    if (url.pathname === '/api/refresh-manual') {
      return handleRefreshManual(request, env);
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
 * Main function: visit barchart.com, get WAF token, fetch data.
 *
 * API calls are ALWAYS executed inside the browser (page.evaluate). This matters
 * because the AWS WAF token is bound to the client (IP/TLS) that solved the JS
 * challenge. Calling the API from a server-side fetch with a copied token gets
 * 403. By executing in-browser, we reuse the browser's validated session.
 *
 * Modes:
 *   - auto:   no manual token -> puppeteer solves the WAF challenge, then we use
 *             its own fresh token in-browser. Reliable from any IP.
 *   - manual: a pasted token is injected as the aws-waf-token cookie before the
 *             in-browser calls. This only works when this browser shares the IP
 *             of the browser that minted the token (e.g. local wrangler dev).
 */
async function fetchAndStoreData(env: Env, manualWafToken?: string) {
  let browser: any = null;

  try {
    console.log('Connecting to browser...');
    browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
    );

    // Navigate to barchart to solve the WAF JS challenge (also sets up the page
    // context / referer that the API calls expect)
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

    await sleep(3000);

    // If a manual token was pasted, inject it as the aws-waf-token cookie so the
    // in-browser API calls use it (overrides whatever the browser solved).
    if (manualWafToken) {
      console.log('Injecting manually supplied aws-waf-token into browser...');
      await page.setCookie({
        name: 'aws-waf-token',
        value: manualWafToken,
        domain: '.barchart.com',
        path: '/',
        httpOnly: true,
        secure: true
      });
    } else {
      const cookies = await page.cookies();
      const hasWaf = cookies.some((c: any) => c.name === 'aws-waf-token');
      if (!hasWaf) {
        console.log('No aws-waf-token found, waiting longer...');
        await sleep(5000);
      }
    }

    // Build the in-browser API fetcher (same validated session => valid token)
    const apiFetch = (url: string, referer?: string) => page.evaluate(async ({ url, referer }: any) => {
      const headers: Record<string, string> = { 'accept': 'application/json' };
      if (referer) headers['referer'] = referer;
      const resp = await fetch(url, { headers });
      if (!resp.ok) throw new Error('API returned ' + resp.status);
      return resp.json();
    }, { url, referer });

    console.log('Fetching futures data...');
    const mainUrl = 'https://www.barchart.com/proxies/core-api/v1/quotes/get?lists=futures.category.us.all&fields=symbol%2CcontractName%2ClastPrice%2CpriceChange%2CopenPrice%2ChighPrice%2ClowPrice%2Cvolume%2CtradeTime%2Ccategory%2ChasOptions%2CsymbolCode%2CsymbolType&limit=100&page=1&groupBy=category&raw=1';
    const mainReferer = 'https://www.barchart.com/futures/major-commodities';

    const mainData = await apiFetch(mainUrl, mainReferer);
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
        const detailData = await apiFetch(detailUrl, referer);

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

  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
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

async function handleRefreshManual(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { wafToken?: string };
    const wafToken = body.wafToken?.trim();
    
    if (!wafToken) {
      return new Response(JSON.stringify({ error: 'wafToken is required in request body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const result = await fetchAndStoreData(env, wafToken);
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
