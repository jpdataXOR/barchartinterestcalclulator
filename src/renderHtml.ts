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
