import express from 'express';
import http from 'node:http';
import { createBareServer } from '@tomphttp/bare-server-node';
import cors from 'cors';
import path from 'node:path';
import crypto from 'node:crypto';
import { record, getSummary, startAutoSave, save as saveAnalytics } from './analytics.js';

const app = express();
const rootDir = process.cwd();
const bareServer = createBareServer('/bare/');
const PORT = Number(process.env.PORT || 8080);

// Secret path for the analytics dashboard. Override with STATS_PATH env var.
// Default is a random-looking segment so it isn't guessable.
const STATS_PATH = process.env.STATS_PATH || '/stats-6c79aa2465a69be7';
const STATS_PASSWORD = process.env.STATS_PASSWORD || ''; // optional extra layer

startAutoSave();

const SEARCH_ENGINES = [
  'https://duckduckgo.com/?q=%s',
  'https://www.startpage.com/sp/search?q=%s',
  'https://search.brave.com/search?q=%s',
  'https://duckduckgo.com/html/?q=%s',
  'https://lite.duckduckgo.com/lite/?q=%s',
];

const FETCH_TIMEOUT_MS = 2000;
let shuttingDown = false;

app.disable('x-powered-by');

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.static(path.join(rootDir, 'public')));

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

function trackRequest(req) {
  try {
    const url = req.url || '';

    // Skip static assets, the analytics endpoints themselves, and bare/uv internals
    // from cluttering the "page view" numbers — but still count real proxy traffic.
    if (
      url.startsWith(STATS_PATH) ||
      url.startsWith('/assets/') ||
      url.startsWith('/uv/') ||
      url === '/favicon.ico'
    ) {
      return;
    }

    const isProxy = url.startsWith('/bare/') || url.startsWith('/uv/service/');
    const type = isProxy ? 'proxy' : 'page';

    record(type, url, getClientIp(req), req.headers['user-agent']);
  } catch (err) {
    console.warn('[analytics] tracking error:', err.message);
  }
}

function isIgnorableNetworkError(err) {
  if (!err) return false;

  const code = String(err.code || '');
  const name = String(err.name || '');
  const message = String(err.message || '');

  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    code === 'UND_ERR_SOCKET' ||
    name === 'AbortError' ||
    message.includes('aborted') ||
    message.includes('socket hang up')
  );
}

app.get('/api/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'missing q' });

    const query = encodeURIComponent(q);

    for (const tpl of SEARCH_ENGINES) {
      const url = tpl.replace('%s', query);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      req.on('close', () => controller.abort());

      try {
        const response = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          redirect: 'follow',
        });

        if (response.ok) {
          return res.json({ url });
        }
      } catch (err) {
        if (!isIgnorableNetworkError(err)) {
          console.warn(`Search engine check failed: ${url}`, err);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return res.status(502).json({ error: 'no search engine available' });
  } catch (err) {
    next(err);
  }
});

function requireStatsAuth(req, res, next) {
  if (!STATS_PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    const [, pass] = decoded.split(':');
    if (pass === STATS_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Analytics"');
  return res.status(401).send('Authentication required');
}

app.get(`${STATS_PATH}/api/summary`, requireStatsAuth, (req, res) => {
  res.json(getSummary());
});

app.get(STATS_PATH, requireStatsAuth, (req, res) => {
  res.type('html').send(renderDashboardHtml());
});

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>アクセス解析</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1115;
    --panel: #171a21;
    --border: #262b36;
    --text: #e6e8ec;
    --muted: #8a91a3;
    --accent: #6ea8fe;
    --accent2: #5fd4a4;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 24px;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
  }
  .card .label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
  .card .value { font-size: 26px; font-weight: 600; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 24px;
  }
  .panel h2 { font-size: 14px; margin: 0 0 16px; color: var(--muted); font-weight: 600; }
  .bars { display: flex; align-items: flex-end; gap: 4px; height: 140px; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
  .bar { width: 100%; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .bar-label { font-size: 10px; color: var(--muted); margin-top: 4px; white-space: nowrap; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  .tag { display: inline-block; padding: 2px 6px; border-radius: 4px; font-size: 11px; }
  .tag-proxy { background: rgba(111,168,254,0.15); color: var(--accent); }
  .tag-page { background: rgba(95,212,164,0.15); color: var(--accent2); }
  .path-cell { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 12px; }
  .refresh-note { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); padding: 12px 0; font-size: 13px; }
</style>
</head>
<body>
  <h1>📊 アクセス解析</h1>
  <div class="sub">Yoroxy dashboard &middot; <span class="refresh-note">30秒ごとに自動更新</span></div>

  <div class="grid" id="cards"></div>

  <div class="panel">
    <h2>日別アクセス数（直近30日）</h2>
    <div class="bars" id="dailyBars"></div>
  </div>

  <div class="panel">
    <h2>本日の時間帯別アクセス数（UTC）</h2>
    <div class="bars" id="hourlyBars"></div>
  </div>

  <div class="panel">
    <h2>最近のアクセス</h2>
    <table id="recentTable">
      <thead>
        <tr><th>時刻</th><th>種別</th><th>パス</th><th>IP</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

<script>
async function load() {
  const res = await fetch(location.pathname + '/api/summary');
  if (!res.ok) return;
  const data = await res.json();
  render(data);
}

function render(data) {
  const cards = document.getElementById('cards');
  cards.innerHTML = \`
    <div class="card"><div class="label">本日の総アクセス数</div><div class="value">\${data.today.total}</div></div>
    <div class="card"><div class="label">本日のユニークIP</div><div class="value">\${data.today.unique}</div></div>
    <div class="card"><div class="label">本日のプロキシ利用数</div><div class="value">\${data.today.proxy}</div></div>
    <div class="card"><div class="label">累計アクセス数</div><div class="value">\${data.totals.total}</div></div>
  \`;

  const dailyBars = document.getElementById('dailyBars');
  const last30 = data.days.slice(-30);
  const maxDaily = Math.max(1, ...last30.map(d => d.total));
  dailyBars.innerHTML = last30.map(d => \`
    <div class="bar-col" title="\${d.date}: \${d.total}件">
      <div class="bar" style="height:\${Math.max(2, (d.total / maxDaily) * 130)}px"></div>
      <div class="bar-label">\${d.date.slice(5)}</div>
    </div>
  \`).join('') || '<div class="empty">データがありません</div>';

  const hourlyBars = document.getElementById('hourlyBars');
  const maxHourly = Math.max(1, ...data.hourlyToday);
  hourlyBars.innerHTML = data.hourlyToday.map((v, h) => \`
    <div class="bar-col" title="\${h}時: \${v}件">
      <div class="bar" style="height:\${Math.max(2, (v / maxHourly) * 130)}px"></div>
      <div class="bar-label">\${h}</div>
    </div>
  \`).join('');

  const tbody = document.querySelector('#recentTable tbody');
  tbody.innerHTML = data.recent.map(r => \`
    <tr>
      <td>\${new Date(r.ts).toLocaleString('ja-JP')}</td>
      <td><span class="tag tag-\${r.type}">\${r.type === 'proxy' ? 'プロキシ' : 'ページ'}</span></td>
      <td class="path-cell">\${escapeHtml(r.path)}</td>
      <td>\${escapeHtml(r.ip)}</td>
    </tr>
  \`).join('') || '<tr><td colspan="4" class="empty">データがありません</td></tr>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}

app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use((err, _req, res, _next) => {
  if (isIgnorableNetworkError(err)) {
    console.warn('Ignored request-level network error:', {
      code: err?.code,
      name: err?.name,
      message: err?.message,
    });

    if (!res.headersSent) {
      return res.status(499).json({ error: 'client closed request' });
    }
    return;
  }

  console.error('Express error:', err);

  if (res.headersSent) return;
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer((req, res) => {
  trackRequest(req);

  req.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Request stream error:', err);
    }
  });

  res.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Response stream error:', err);
    }
  });

  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeRequest(req, res);
    } else {
      app(req, res);
    }
  } catch (err) {
    if (isIgnorableNetworkError(err)) {
      console.warn('Ignored routing abort:', err?.message || err);
      return;
    }

    console.error('Request routing error:', err);

    if (!res.headersSent) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    } else {
      res.destroy();
    }
  }
});

server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    if (!isIgnorableNetworkError(err)) {
      console.warn('Socket error during upgrade:', err);
    }
  });

  try {
    if (bareServer.shouldRoute(req)) {
      bareServer.routeUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  } catch (err) {
    if (isIgnorableNetworkError(err)) {
      console.warn('Ignored upgrade abort:', err?.message || err);
      socket.destroy();
      return;
    }

    console.error('Upgrade routing error:', err);
    socket.destroy();
  }
});

server.on('clientError', (err, socket) => {
  if (isIgnorableNetworkError(err)) {
    socket.destroy();
    return;
  }

  console.warn('clientError:', err);

  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } else {
    socket.destroy();
  }
});

server.on('error', (err) => {
  console.error('HTTP server error:', err);
});

process.on('uncaughtException', (err) => {
  if (isIgnorableNetworkError(err)) {
    console.warn('Ignored uncaught network error:', {
      code: err?.code,
      name: err?.name,
      message: err?.message,
    });
    return;
  }

  console.error('uncaughtException:', err);
  shutdown(1);
});

process.on('unhandledRejection', (reason) => {
  if (isIgnorableNetworkError(reason)) {
    console.warn('Ignored unhandled network rejection:', reason);
    return;
  }

  console.error('unhandledRejection:', reason);
  shutdown(1);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(PORT, () => {
  console.log(`Server Listening on ${PORT}`);
});

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log('Shutting down...');
  saveAnalytics();

  const forceExitTimer = setTimeout(() => {
    console.error('Forced exit after shutdown timeout');
    process.exit(exitCode || 1);
  }, 5000);
  forceExitTimer.unref();

  try {
    server.close(() => {
      try {
        bareServer.close();
      } catch (err) {
        console.error('bareServer.close error:', err);
      }

      clearTimeout(forceExitTimer);
      process.exit(exitCode);
    });
  } catch (err) {
    console.error('server.close error:', err);
    clearTimeout(forceExitTimer);
    process.exit(1);
  }
}
