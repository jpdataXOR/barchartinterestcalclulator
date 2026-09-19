/**
 * Generate futures analysis HTML report from barchart-data.json
 * Calculates roll yield (contango/backwardation) to find LONG/SHORT opportunities
 *
 * Usage: node generate-report.js
 */

const fs = require('fs');
const data = JSON.parse(fs.readFileSync('barchart-data.json', 'utf8'));

// Month code mapping
const MONTHS = { F:1, G:2, H:3, J:4, K:5, M:6, N:7, Q:8, U:9, V:10, X:11, Z:12 };
const MONTH_NAMES = { F:'Jan', G:'Feb', H:'Mar', J:'Apr', K:'May', M:'Jun', N:'Jul', Q:'Aug', U:'Sep', V:'Oct', X:'Nov', Z:'Dec' };

// Point values for dollar calculations
const POINT_VALUES = {
  ZC:50, ZS:50, ZW:50, ZL:600, ZO:50, ZR:200, ZM:100,
  CL:1000, NG:10000, QA:1000, RB:42000, HO:42000,
  GC:100, SI:5000, HG:25000, PL:50, PA:100, AL:100,
  LE:400, HE:400, GF:500,
  CT:500, KC:375, SB:1120, CC:10, LB:100, OJ:150,
  ES:50, NQ:20, ET:5, NM:5, YM:5, VI:1000,
  E6:125000, A6:100000, B6:62500, D6:100000, J6:12500000,
  S6:125000, M6:500000, N6:100000, L6:100000, T6:500000, BT:5, DX:1000,
  ZN:1000, ZF:1000, ZT:2000, ZB:1000, TN:1000, UD:1000
};

function parseContract(symbol) {
  const m = symbol?.match(/^[A-Z0-9]{2}([FGHJKMNQUVXZ])(\d{2})$/);
  if (!m) return null;
  return { monthCode: m[1], monthNum: MONTHS[m[1]], year: 2000 + parseInt(m[2]) };
}

function getContractOrder(a, b) {
  const pa = parseContract(a), pb = parseContract(b);
  if (!pa || !pb) return 0;
  return (pa.year - pb.year) || (pa.monthNum - pb.monthNum);
}

function getMonthsBetween(a, b) {
  const pa = parseContract(a), pb = parseContract(b);
  if (!pa || !pb) return 30;
  let diff = (pb.year - pa.year) * 12 + (pb.monthNum - pa.monthNum);
  return Math.max(diff, 1) * 30;
}

// Group contracts by root symbol
const byRoot = {};
for (const c of data.allContracts) {
  if (!byRoot[c.rootSymbol]) byRoot[c.rootSymbol] = [];
  byRoot[c.rootSymbol].push(c);
}

// Find front month info from futuresData
const frontInfo = {};
for (const f of data.futuresData) {
  frontInfo[f.rootSymbol] = f;
}

const yieldAnalysis = [];

for (const [root, contracts] of Object.entries(byRoot)) {
  // Sort by expiration
  contracts.sort((a, b) => getContractOrder(a.symbol, b.symbol));

  // Skip cash contracts (Y00)
  const tradeable = contracts.filter(c => !c.symbol.includes('Y00') && !c.contractSymbol?.includes('(Cash)'));

  if (tradeable.length < 2) continue;

  const front = tradeable[0];
  const next = tradeable[1];
  const fi = frontInfo[root];

  const priceDiff = (next.lastPrice || 0) - (front.lastPrice || 0);
  const estDays = getMonthsBetween(front.symbol, next.symbol);
  const dailyBasis = estDays > 0 ? priceDiff / estDays : 0;

  const curveType = priceDiff > 0.0001 ? 'Contango' : priceDiff < -0.0001 ? 'Backwardation' : 'Flat';
  const favoredSide = curveType === 'Contango' ? 'SHORT' : curveType === 'Backwardation' ? 'LONG' : 'NEUTRAL';

  const pv = POINT_VALUES[root] || 100;
  const dailyValue = Math.abs(dailyBasis) * pv;
  const annualizedBasis = dailyBasis * 365;
  const annualizedPercent = front.lastPrice ? (annualizedBasis / front.lastPrice) * 100 : 0;

  yieldAnalysis.push({
    root, name: fi?.contractName?.replace(/\([^)]*\)/g, '').trim() || root,
    category: fi?.category || '',
    frontSymbol: front.symbol,
    nextSymbol: next.symbol,
    frontPrice: front.lastPrice,
    nextPrice: next.lastPrice,
    priceDiff, dailyBasis, dailyValue,
    annualizedPercent: annualizedPercent.toFixed(2),
    curveType, favoredSide,
    estDays, pointValue: pv
  });
}

const longOpps = yieldAnalysis.filter(y => y.curveType === 'Backwardation')
  .sort((a, b) => Math.abs(parseFloat(b.annualizedPercent)) - Math.abs(parseFloat(a.annualizedPercent)));
const shortOpps = yieldAnalysis.filter(y => y.curveType === 'Contango')
  .sort((a, b) => Math.abs(parseFloat(b.annualizedPercent)) - Math.abs(parseFloat(a.annualizedPercent)));

const ts = data.fetchedAt || new Date().toISOString();

function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function oppRows(list, type) {
  return list.map(y => {
    const cls = type === 'LONG' ? 'positive' : 'negative';
    const badge = type === 'LONG' ? 'badge-long' : 'badge-short';
    const annPct = parseFloat(y.annualizedPercent);
    return `<tr>
      <td><strong>${esc(y.root)}</strong></td>
      <td>${esc(y.name)}</td>
      <td>${esc(y.category)}</td>
      <td>${esc(y.frontSymbol)}</td>
      <td>${esc(y.nextSymbol)}</td>
      <td>${y.frontPrice}</td>
      <td>${y.nextPrice}</td>
      <td class="${cls}">${y.priceDiff > 0 ? '+' : ''}${y.priceDiff.toFixed(4)}</td>
      <td class="${cls}">${annPct > 0 ? '+' : ''}${annPct.toFixed(2)}%</td>
      <td>$${y.dailyValue.toFixed(2)}</td>
      <td><span class="badge ${badge}">${type}</span></td>
    </tr>`;
  }).join('\n');
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Futures Roll Yield Analysis - ${ts}</title>
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
  <div class="ts">Generated: ${ts}</div>
</div>
<div class="stats">
  <div class="stat-box"><div class="num">${yieldAnalysis.length}</div><div class="label">Instruments Analyzed</div></div>
  <div class="stat-box"><div class="num">${longOpps.length}</div><div class="label">LONG Opportunities</div></div>
  <div class="stat-box"><div class="num">${shortOpps.length}</div><div class="label">SHORT Opportunities</div></div>
  <div class="stat-box"><div class="num">${data.stats?.totalContractDetails || 0}</div><div class="label">Contract Months</div></div>
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
    <thead><tr>
      <th>Symbol</th><th>Name</th><th>Category</th><th>Front</th><th>Next</th>
      <th>Front $</th><th>Next $</th><th>Diff</th><th>Ann. Yield</th><th>Daily $/ctr</th><th>Signal</th>
    </tr></thead>
    <tbody>${oppRows(longOpps, 'LONG')}</tbody>
  </table>
</div>

<div id="short" class="tab-content">
  <h2 style="color:#f85149;margin-bottom:8px;">SHORT Opportunities — Contango</h2>
  <p style="color:#8b949e;font-size:0.85em;margin-bottom:12px;">
    Front month < next month → futures curve slopes UP → roll yield is NEGATIVE for longs (positive for shorts).
    Higher annualized % = stronger contango.
  </p>
  <table id="shortTable" class="display">
    <thead><tr>
      <th>Symbol</th><th>Name</th><th>Category</th><th>Front</th><th>Next</th>
      <th>Front $</th><th>Next $</th><th>Diff</th><th>Ann. Yield</th><th>Daily $/ctr</th><th>Signal</th>
    </tr></thead>
    <tbody>${oppRows(shortOpps, 'SHORT')}</tbody>
  </table>
</div>

<div id="all" class="tab-content">
  <h2 style="color:#58a6ff;margin-bottom:8px;">All Instruments — Yield Analysis</h2>
  <table id="allTable" class="display">
    <thead><tr>
      <th>Symbol</th><th>Name</th><th>Category</th><th>Front</th><th>Next</th>
      <th>Front $</th><th>Next $</th><th>Diff</th><th>Ann. Yield</th><th>Curve</th><th>Signal</th>
    </tr></thead>
    <tbody>${yieldAnalysis.map(y => {
      const isLong = y.curveType === 'Backwardation';
      const isShort = y.curveType === 'Contango';
      const cls = isLong ? 'positive' : isShort ? 'negative' : '';
      const badge = isLong ? 'badge-long' : isShort ? 'badge-short' : '';
      const label = isLong ? 'LONG' : isShort ? 'SHORT' : 'FLAT';
      const curveBadge = isLong ? 'badge-backwardation' : isShort ? 'badge-contango' : '';
      const annPct = parseFloat(y.annualizedPercent);
      return `<tr>
        <td><strong>${esc(y.root)}</strong></td>
        <td>${esc(y.name)}</td>
        <td>${esc(y.category)}</td>
        <td>${esc(y.frontSymbol)}</td>
        <td>${esc(y.nextSymbol)}</td>
        <td>${y.frontPrice}</td>
        <td>${y.nextPrice}</td>
        <td class="${cls}">${y.priceDiff > 0 ? '+' : ''}${y.priceDiff.toFixed(4)}</td>
        <td class="${cls}">${annPct > 0 ? '+' : ''}${annPct.toFixed(2)}%</td>
        <td><span class="badge ${curveBadge}">${y.curveType}</span></td>
        <td><span class="badge ${badge}">${label}</span></td>
      </tr>`;
    }).join('\n')}</tbody>
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
\$(document).ready(function() {
  \$('#longTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });
  \$('#shortTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });
  \$('#allTable').DataTable({ pageLength: 50, order: [[8, 'desc']] });

  \$('.tab').click(function() {
    \$('.tab').removeClass('active');
    \$('.tab-content').removeClass('active');
    \$(this).addClass('active');
    \$('#' + \$(this).data('tab')).addClass('active');
  });
});
</script>
</body>
</html>`;

fs.writeFileSync('futures_roll_yield_report.html', html);
console.log(`Report generated: futures_roll_yield_report.html`);
console.log(`  Instruments analyzed: ${yieldAnalysis.length}`);
console.log(`  LONG opportunities: ${longOpps.length}`);
console.log(`  SHORT opportunities: ${shortOpps.length}`);