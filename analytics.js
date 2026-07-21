import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'analytics.json');
const SAVE_INTERVAL_MS = 30_000;
const MAX_RECENT = 200;
const MAX_DAYS = 90;

/**
 * In-memory shape:
 * {
 *   days: { 'YYYY-MM-DD': { total, proxy, page, uniqueIPs: Set<string> } },
 *   hourly: { 'YYYY-MM-DD': [24 numbers] },
 *   recent: [{ ts, path, type, ip, ua }],
 *   totals: { total, proxy, page }
 * }
 */
let state = {
  days: {},
  hourly: {},
  recent: [],
  totals: { total: 0, proxy: 0, page: 0 },
};

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      state = {
        days: parsed.days || {},
        hourly: parsed.hourly || {},
        recent: parsed.recent || [],
        totals: parsed.totals || { total: 0, proxy: 0, page: 0 },
      };
      // convert unique IP arrays back to Sets for internal counting freshness
      for (const key of Object.keys(state.days)) {
        if (Array.isArray(state.days[key].uniqueIPs)) {
          state.days[key]._uniqueSet = new Set(state.days[key].uniqueIPs);
        } else {
          state.days[key]._uniqueSet = new Set();
        }
      }
      console.log(`[analytics] Loaded existing data from ${DATA_FILE}`);
    }
  } catch (err) {
    console.warn('[analytics] Failed to load existing data:', err.message);
  }
}

function ensureDay(key) {
  if (!state.days[key]) {
    state.days[key] = { total: 0, proxy: 0, page: 0, uniqueIPs: [], _uniqueSet: new Set() };
  }
  if (!state.hourly[key]) {
    state.hourly[key] = new Array(24).fill(0);
  }
  return state.days[key];
}

function pruneOldDays() {
  const keys = Object.keys(state.days).sort();
  if (keys.length > MAX_DAYS) {
    const toRemove = keys.slice(0, keys.length - MAX_DAYS);
    for (const k of toRemove) {
      delete state.days[k];
      delete state.hourly[k];
    }
  }
}

/**
 * Record a single hit.
 * @param {'page'|'proxy'} type
 * @param {string} reqPath
 * @param {string} ip
 * @param {string} ua
 */
export function record(type, reqPath, ip, ua) {
  const now = new Date();
  const key = todayKey(now);
  const day = ensureDay(key);

  day.total += 1;
  day[type] = (day[type] || 0) + 1;
  if (ip) day._uniqueSet.add(ip);

  state.hourly[key][now.getUTCHours()] += 1;

  state.totals.total += 1;
  state.totals[type] = (state.totals[type] || 0) + 1;

  state.recent.unshift({
    ts: now.toISOString(),
    path: reqPath,
    type,
    ip: ip || '',
    ua: (ua || '').slice(0, 160),
  });
  if (state.recent.length > MAX_RECENT) {
    state.recent.length = MAX_RECENT;
  }

  pruneOldDays();
}

export function getSummary() {
  const keys = Object.keys(state.days).sort();
  const days = keys.map((k) => ({
    date: k,
    total: state.days[k].total,
    proxy: state.days[k].proxy,
    page: state.days[k].page,
    unique: state.days[k]._uniqueSet.size,
  }));

  const todayK = todayKey();
  const hourlyToday = state.hourly[todayK] || new Array(24).fill(0);

  return {
    totals: state.totals,
    today: days.find((d) => d.date === todayK) || { date: todayK, total: 0, proxy: 0, page: 0, unique: 0 },
    days,
    hourlyToday,
    recent: state.recent.slice(0, 50),
  };
}

export function save() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const serializable = {
      days: Object.fromEntries(
        Object.entries(state.days).map(([k, v]) => [
          k,
          { total: v.total, proxy: v.proxy, page: v.page, uniqueIPs: Array.from(v._uniqueSet) },
        ])
      ),
      hourly: state.hourly,
      recent: state.recent,
      totals: state.totals,
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(serializable), 'utf-8');
  } catch (err) {
    console.warn('[analytics] Failed to save data:', err.message);
  }
}

export function startAutoSave() {
  load();
  const timer = setInterval(save, SAVE_INTERVAL_MS);
  timer.unref();
  return timer;
}
