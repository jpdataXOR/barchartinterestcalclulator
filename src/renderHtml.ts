export function renderHtml() {
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
    .btn { background: #e94560; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; }
    .btn:hover { background: #c73650; }
    .btn-secondary { background: #0f3460; }
    .btn-secondary:hover { background: #1a4a7a; }
    pre { background: #0f3460; padding: 15px; border-radius: 4px; overflow-x: auto; }
    input[type="text"] { background: #0f3460; border: 1px solid #e94560; color: #eee; padding: 10px; border-radius: 4px; width: 100%; max-width: 600px; font-family: monospace; font-size: 12px; box-sizing: border-box; }
    input[type="text"]:focus { outline: none; border-color: #fff; }
    .link { color: #e94560; text-decoration: underline; cursor: pointer; }
    .link:hover { color: #fff; }
    .instruction { background: #0f3460; padding: 15px; border-radius: 4px; margin: 10px 0; font-size: 13px; line-height: 1.6; }
    .instruction ol { margin: 10px 0; padding-left: 20px; }
    .instruction li { margin: 8px 0; }
    .instruction code { background: #1a1a2e; padding: 2px 6px; border-radius: 3px; font-family: monospace; }
    .token-display { background: #0f3460; padding: 10px; border-radius: 4px; word-break: break-all; font-family: monospace; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Futures Analysis</h1>
    
    <div class="card">
      <p>Uses Cloudflare Browser Run (CDP) to fetch data from Barchart.com</p>
      <button class="btn" onclick="refresh()">Refresh Data (Auto)</button>
      <button class="btn btn-secondary" onclick="loadData()">View Data</button>
      <div id="status"></div>
    </div>

    <div class="card">
      <h3>Manual WAF Token (if auto fails)</h3>
      <p>
        <a href="https://www.barchart.com/futures/major-commodities" target="_blank" class="link">→ Open Barchart Futures Page</a>
        (opens in new tab)
      </p>
      <div class="instruction">
        <strong>How to get the WAF token from Chrome:</strong>
        <ol>
          <li>Open the <a href="https://www.barchart.com/futures/major-commodities" target="_blank" class="link">Barchart page</a> in Chrome</li>
          <li>Press <code>F12</code> (or right-click → Inspect) to open DevTools</li>
          <li>Go to the <strong>Application</strong> tab (or <strong>Storage</strong> tab in newer Chrome)</li>
          <li>In the left sidebar, expand <strong>Cookies</strong> → <code>https://www.barchart.com</code></li>
          <li>Find the cookie named <code>aws-waf-token</code></li>
          <li>Double-click the <strong>Value</strong> column to select it, then copy (<code>Ctrl+C</code>)</li>
        </ol>
      </div>
      <input type="text" id="manualToken" placeholder="Paste aws-waf-token value here..." />
      <br><br>
      <button class="btn" onclick="refreshManual()">Refresh with Manual Token</button>
      <div id="manualStatus"></div>
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
    
    async function refreshManual() {
      const token = document.getElementById('manualToken').value.trim();
      if (!token) {
        document.getElementById('manualStatus').textContent = 'Please enter a WAF token';
        return;
      }
      document.getElementById('manualStatus').textContent = 'Refreshing with manual token...';
      const r = await fetch('/api/refresh-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wafToken: token })
      });
      const d = await r.json();
      document.getElementById('manualStatus').textContent = d.error || 'Done! ' + JSON.stringify(d.stats);
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
