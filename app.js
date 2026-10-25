'use strict';
/* GoldTerm — live XAU/USD charting, trade outcome estimation and journal analytics.
   Everything runs in the browser; journal + settings live in localStorage. */

// ---------- helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok = v => v != null && isFinite(v);
const fmt = (v, d = 2) => ok(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const usd = v => ok(v) ? (v < 0 ? '-$' : '$') + fmt(Math.abs(v)) : '—';
const pct = (v, d = 0) => ok(v) ? (v * 100).toFixed(d) + '%' : '—';
const sgn = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const r2 = v => Math.round(v * 100) / 100;
const num = v => v === '' || v == null ? null : (isFinite(+v) ? +v : null);
const store = {
  get(k, d) { try { const v = localStorage.getItem('goldterm.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('goldterm.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
const OZ = 100; // 1 standard lot of XAU/USD = 100 troy oz
const TF = {
  '1m': { bn: '1m', td: '1min', sec: 60 }, '5m': { bn: '5m', td: '5min', sec: 300 },
  '15m': { bn: '15m', td: '15min', sec: 900 }, '1h': { bn: '1h', td: '1h', sec: 3600 },
  '4h': { bn: '4h', td: '4h', sec: 14400 }, '1d': { bn: '1d', td: '1day', sec: 86400 },
};
const durText = s => s < 3600 ? Math.round(s / 60) + ' min' : s < 172800 ? (s / 3600).toFixed(1) + ' h' : (s / 86400).toFixed(1) + ' days';
const sessionOf = ms => { const h = new Date(ms).getUTCHours(); return h < 7 ? 'Asia' : h < 12 ? 'London' : h < 16 ? 'London/NY overlap' : h < 21 ? 'New York' : 'Rollover'; };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- state ----------
const settings = Object.assign({ provider: 'auto', tdKey: '', offset: 0, balance: 10000, risk: 1, autoClose: true, spotAlign: true, spotHours: true }, store.get('settings', {}));
if (settings.provider === 'twelve') settings.provider = 'spot';
const ui = Object.assign({ tf: '15m', ema20: true, ema50: true, ema200: true, bb: false, vwap: false, rsi: true, sr: true, marks: true, siglv: true, alerts: true, tab: 'market' }, store.get('ui', {}));
const plan = Object.assign({ dir: 'long', entry: null, sl: null, tp: null, lots: 0.1, market: true }, store.get('plan', {}));
let trades = store.get('trades', []);
{ // trades synced from MetaTrader (journal-sync.js, made by tools/mt5-sync.mjs): add new ones, update ones
  // that changed (e.g. closed since the last sync), and never re-add one you deleted.
  const removed = new Set(store.get('syncDeleted', []));
  for (const s of window.PRESET_TRADES || []) {
    if (removed.has(s.id)) continue;
    const cur = trades.find(t => t.id === s.id);
    if (!cur) trades.push(finalize({ ...s }));
    else if (cur.status !== s.status || cur.exit !== s.exit || cur.sl !== s.sl || cur.tp !== s.tp) Object.assign(cur, finalize({ ...cur, ...s, tag: cur.tag || s.tag, notes: cur.notes || s.notes }));
  }
  store.set('trades', trades);
}
let drawings = store.get('drawings', []);
{ // levels imported via levels.js: add each once, so a deleted one stays deleted
  const seen = new Set(store.get('presetSeen', []));
  for (const d of window.PRESET_DRAWINGS || []) if (!seen.has(d.id)) { drawings.push(d); seen.add(d.id); }
  store.set('presetSeen', [...seen]); store.set('drawings', drawings);
}
let candles = [];
let calc = null;
let lastPrice = null;
const saveUI = () => store.set('ui', ui);
const saveTrades = () => store.set('trades', trades);

// ---------- data sources ----------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// --- spot-market calendar (New York time) ---
// Spot gold trades Sun 18:00 → Fri 17:00 New York, with a daily 17:00–18:00 break.
// Brokers start each daily (and 4H) candle at the 17:00 New York close.
const H = 3600;
const nyFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const nyOffCache = new Map();
function nyOffset(sec) { // seconds to add to UTC to get New York wall time (-4h or -5h)
  const k = Math.floor(sec / H);
  let v = nyOffCache.get(k);
  if (v == null) {
    const o = {};
    for (const p of nyFmt.formatToParts(new Date(k * H * 1000))) o[p.type] = p.value;
    v = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute) / 1000 - k * H;
    nyOffCache.set(k, v);
  }
  return v;
}
function spotOpen(sec) {
  const d = new Date((sec + nyOffset(sec)) * 1000), wd = d.getUTCDay(), h = d.getUTCHours();
  if (wd === 6 || (wd === 5 && h >= 17) || (wd === 0 && h < 18)) return false;
  return h !== 17;
}
// Candle start for a timestamp. 4H/1D follow the New York close like MT4/MT5 brokers;
// daily candles are labelled with their trading date.
function bucketFor(tf, sec) {
  if (tf === '1d') return Math.floor((sec + nyOffset(sec) + 7 * H) / 86400) * 86400;
  if (tf === '4h') { const off = nyOffset(sec); return Math.floor((sec + off + 7 * H) / (4 * H)) * 4 * H - off - 7 * H; }
  return Math.floor(sec / TF[tf].sec) * TF[tf].sec;
}
function barEnd(time) {
  if (ui.tf === '1d' && feed.key !== 'spot') return time + 17 * H - nyOffset(time);
  return time + TF[ui.tf].sec;
}
const spotFilter = bars => settings.spotHours ? bars.filter(b => spotOpen(b.time)) : bars;
function aggregate(bars, tf) {
  const out = [];
  for (const b of bars) {
    const t = bucketFor(tf, b.time), last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low);
      last.close = b.close; last.volume += b.volume;
    } else out.push({ ...b, time: t });
  }
  return out;
}

// --- Binance ---
const BN = {
  bnFut: {
    max: 1500, quiet: 30000,
    rest: (i, l, end) => `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${i}&limit=${l}${end ? '&endTime=' + end : ''}`,
    ws: ['wss://fstream.binance.com/market/ws/xauusdt@aggTrade', 'wss://fstream.binance.com/ws/xauusdt@aggTrade'],
  },
  bnPaxg: {
    max: 1000, quiet: 180000,
    rest: (i, l, end) => `https://data-api.binance.vision/api/v3/klines?symbol=PAXGUSDT&interval=${i}&limit=${l}${end ? '&endTime=' + end : ''}`,
    ws: ['wss://data-stream.binance.vision/ws/paxgusdt@aggTrade', 'wss://stream.binance.com:9443/ws/paxgusdt@aggTrade'],
  },
};
async function bnPaged(cfg, interval, total) {
  let out = [], end = null;
  while (out.length < total) {
    const lim = Math.min(cfg.max, total - out.length);
    const rows = await getJSON(cfg.rest(interval, lim, end));
    if (!Array.isArray(rows) || !rows.length) break;
    out = rows.map(k => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] })).concat(out);
    if (rows.length < lim) break; // reached the start of the listing
    end = rows[0][0] - 1;
  }
  if (!out.length) throw new Error('no data');
  return out;
}
async function bnHistory(cfg, tf, n) {
  if (tf === '4h' || tf === '1d') { // rebuild from 1H so candles open at the New York close
    const hours = await bnPaged(cfg, '1h', Math.ceil(n * (tf === '4h' ? 4 : 24) * 1.45));
    return aggregate(spotFilter(hours), tf).slice(-n);
  }
  return spotFilter(await bnPaged(cfg, TF[tf].bn, n));
}
// Trade-by-trade stream. A watchdog reconnects (rotating to the next URL) if the socket
// stays open but goes silent — Binance has moved stream paths before.
function bnStream(cfg, onTick) {
  let ws, closed = false, retry = 1000, idx = 0, lastMsg = 0;
  const open = () => {
    const sock = ws = new WebSocket(cfg.ws[idx % cfg.ws.length]);
    lastMsg = Date.now();
    sock.onopen = () => { retry = 1000; setStatus('live', 'ok'); };
    sock.onmessage = e => {
      lastMsg = Date.now();
      const m = JSON.parse(e.data), d = m.data || m;
      if (d.e === 'aggTrade' || d.e === 'trade') onTick({ price: +d.p, qty: +d.q, ms: d.T });
    };
    sock.onclose = () => {
      if (closed || sock !== ws) return;
      setStatus('reconnecting', 'warn');
      setTimeout(open, retry); retry = Math.min(retry * 2, 30000);
    };
    sock.onerror = () => sock.close();
  };
  const watchdog = setInterval(() => {
    if (ws && ws.readyState === 1 && Date.now() - lastMsg > cfg.quiet) {
      idx++; setStatus('stream stalled — switching', 'warn'); ws.close();
    }
  }, 5000);
  open();
  return () => { closed = true; clearInterval(watchdog); ws && ws.close(); };
}

// --- Twelve Data (true spot XAU/USD candles) ---
async function tdSeries(tf, n) {
  if (!settings.tdKey) throw new Error('Twelve Data API key not set');
  const j = await getJSON(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${TF[tf].td}&outputsize=${n}&timezone=UTC&apikey=${encodeURIComponent(settings.tdKey)}`);
  if (j.status === 'error' || !j.values) throw new Error(j.message || 'Twelve Data error');
  return j.values.map(v => {
    const iso = v.datetime.length === 10 ? v.datetime + 'T00:00:00Z' : v.datetime.replace(' ', 'T') + 'Z';
    return { time: Math.floor(Date.parse(iso) / 1000), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: 0 };
  }).reverse();
}

const SOURCES = {
  spot: {
    name: 'Spot XAU/USD · Twelve Data + live ticks',
    note: 'Candle history is real spot XAU/USD from Twelve Data (re-synced every 3 min). The forming candle moves with live Binance gold trades converted to spot.',
    history: (tf, n = 1000) => tdSeries(tf, n),
    stream: cb => bnStream(BN.bnFut, cb),
  },
  bnFut: {
    name: 'Binance · XAUUSDT perp', note: 'Gold perpetual futures on Binance, streamed trade by trade.',
    history: (tf, n) => bnHistory(BN.bnFut, tf, n ?? (tf === '1d' ? 400 : 1000)),
    stream: cb => bnStream(BN.bnFut, cb),
  },
  bnPaxg: {
    name: 'Binance · PAXG/USDT', note: 'PAX Gold token (1 token = 1 troy oz), a proxy for XAU/USD.',
    history: (tf, n) => bnHistory(BN.bnPaxg, tf, n ?? (tf === '1d' ? 400 : 1000)),
    stream: cb => bnStream(BN.bnPaxg, cb),
  },
};

// History is kept "raw" (perp prices for Binance, spot prices for Twelve Data).
// Display = raw + manual offset (+ measured spot basis for Binance history).
let raw = [], lastRaw = null, basis = 0, basisKey = null, basisSamples = [], lastSpotStamp = null;
const tickHist = [];
const histOffset = () => (+settings.offset || 0) + (feed.key !== 'spot' && settings.spotAlign ? basis : 0);
const shift = (b, o = histOffset()) => o ? { ...b, open: b.open + o, high: b.high + o, low: b.low + o, close: b.close + o } : { ...b };
function rebuildDisplay() {
  if (!raw.length) return;
  candles = raw.map(b => shift(b));
  candleSeries.setData(candles);
  volSeries.setData(candles.map(volPoint));
  onPrice(candles[candles.length - 1].close);
  srKey = '';
  recalc();
}
function noteRaw(price, ms) {
  lastRaw = price;
  const last = tickHist[tickHist.length - 1];
  if (!last || ms - last.t >= 250) tickHist.push({ t: ms, p: price });
  while (tickHist.length && tickHist[0].t < ms - 300000) tickHist.shift();
}
function rawAt(ms) { // Binance price at a past moment, to compare with a timestamped spot quote
  for (let i = tickHist.length - 1; i >= 0; i--) if (tickHist[i].t <= ms) return tickHist[i].p;
  return null;
}
// Measure the Binance premium over spot XAU/USD (gold-api.com) and remove it.
async function calibrateSpot() {
  const needed = feed.key === 'spot' || settings.spotAlign;
  if (needed && feed.key && lastRaw != null) {
    try {
      const j = await getJSON('https://api.gold-api.com/price/XAU');
      const spot = +j.price, at = Date.parse(j.updatedAt);
      if (spot > 0 && Date.now() - at < 180000 && j.updatedAt !== lastSpotStamp) { // stale quote = spot market closed
        lastSpotStamp = j.updatedAt;
        const ref = rawAt(at) ?? lastRaw;
        basisSamples.push(spot - ref);
        if (basisSamples.length > 9) basisSamples.shift();
        const sorted = [...basisSamples].sort((a, b) => a - b), med = r2(sorted[sorted.length >> 1]);
        if (Math.abs(med - basis) >= 0.05) { basis = med; if (feed.key !== 'spot') rebuildDisplay(); }
      }
    } catch { /* keep previous basis */ }
  }
  renderSourceBadge();
}
setInterval(calibrateSpot, 20000);
// Spot mode: replace tick-built candles with Twelve Data's real ones every 3 minutes.
async function resyncSpot() {
  if (feed.key !== 'spot' || !raw.length) return;
  const gen = feed.gen;
  try {
    const bars = await tdSeries(ui.tf, 4);
    if (gen !== feed.gen) return;
    for (const b of bars) {
      let i = raw.length - 1;
      while (i >= 0 && raw[i].time > b.time) i--;
      if (i >= 0 && raw[i].time === b.time) {
        const cur = raw[i];
        raw[i] = i === raw.length - 1 ? { ...b, high: Math.max(b.high, cur.close), low: Math.min(b.low, cur.close), close: cur.close } : b;
      } else if (b.time > raw[raw.length - 1].time) raw.push(b);
    }
    rebuildDisplay();
  } catch (e) { setStatus('Twelve Data: ' + e.message, 'warn'); }
}
setInterval(resyncSpot, 180000);
function renderSourceBadge() {
  const src = SOURCES[feed.key];
  if (!src) return;
  const aligned = feed.key !== 'spot' && settings.spotAlign && basisSamples.length;
  const badge = $('#srcBadge');
  badge.textContent = src.name + (aligned ? ` · spot-aligned ${basis >= 0 ? '+' : ''}${fmt(basis)}` : '');
  badge.title = src.note + (aligned ? `\nShifted by ${fmt(basis)} so prices match spot XAU/USD (gold-api.com, recalibrated every 20s).` : '') +
    (settings.spotHours ? '\nCandles from hours when the spot market is closed are hidden.' : '');
}
function setStatus(text, cls) {
  const s = $('#status'); s.className = 'status ' + cls; s.querySelector('b').textContent = text;
}

const feed = { key: null, stop: null, gen: 0, phase: 0 };
async function loadFeed() {
  const gen = ++feed.gen;
  if (feed.stop) feed.stop();
  feed.stop = null;
  setStatus('loading', 'warn');
  const p = settings.provider;
  const order = p === 'auto' ? (settings.tdKey ? ['spot', 'bnFut', 'bnPaxg'] : ['bnFut', 'bnPaxg']) : [p];
  let err;
  for (const key of order) {
    try {
      const bars = await SOURCES[key].history(ui.tf);
      if (gen !== feed.gen) return;
      if (!bars.length) throw new Error('no data');
      feed.key = key;
      feed.seeded = false;
      if (basisKey !== (key === 'bnPaxg' ? 'paxg' : 'fut')) { // spot mode and perp share the same basis
        basisKey = key === 'bnPaxg' ? 'paxg' : 'fut'; basis = 0; basisSamples = []; lastSpotStamp = null; tickHist.length = 0; lastRaw = null;
      }
      raw = bars;
      if (key !== 'spot') lastRaw = raw[raw.length - 1].close;
      feed.phase = ((raw[raw.length - 1].time % TF[ui.tf].sec) + TF[ui.tf].sec) % TF[ui.tf].sec;
      candles = raw.map(b => shift(b));
      renderSourceBadge();
      onHistory();
      feed.stop = SOURCES[key].stream(t => { if (gen === feed.gen) onTick(t); });
      calibrateSpot();
      refreshMTF();
      refreshStrategies();
      return;
    } catch (e) { err = e; }
  }
  setStatus('no data — ' + (err ? err.message : 'unknown'), 'err');
  toast('Could not load market data' + (err ? ': ' + err.message : '') + '. Check Settings.', 6000);
}

// ---------- indicators ----------
function ema(v, p) {
  const out = new Array(v.length).fill(null), k = 2 / (p + 1);
  let prev = null, cnt = 0, sum = 0;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x == null) continue;
    if (prev == null) { sum += x; if (++cnt === p) out[i] = prev = sum / p; }
    else out[i] = prev = x * k + prev * (1 - k);
  }
  return out;
}
function rsi(c, p = 14) {
  const out = new Array(c.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= p) { ag += g; al += l; if (i < p) continue; ag /= p; al /= p; }
    else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; }
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function atr(b, p = 14) {
  const out = new Array(b.length).fill(null);
  let a = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    if (i <= p) { a += tr; if (i < p) continue; a /= p; } else a = (a * (p - 1) + tr) / p;
    out[i] = a;
  }
  return out;
}
function bollinger(c, p = 20, k = 2) {
  const up = [], mid = [], lo = [];
  for (let i = 0; i < c.length; i++) {
    if (i < p - 1) { up.push(null); mid.push(null); lo.push(null); continue; }
    let s = 0; for (let j = i - p + 1; j <= i; j++) s += c[j];
    const m = s / p;
    let v = 0; for (let j = i - p + 1; j <= i; j++) v += (c[j] - m) ** 2;
    const sd = Math.sqrt(v / p);
    up.push(m + k * sd); mid.push(m); lo.push(m - k * sd);
  }
  return { up, mid, lo };
}
function vwap(b) {
  const out = []; let day = null, pv = 0, vv = 0;
  for (const x of b) {
    const d = Math.floor(x.time / 86400);
    if (d !== day) { day = d; pv = 0; vv = 0; }
    pv += (x.high + x.low + x.close) / 3 * x.volume; vv += x.volume;
    out.push(vv > 0 ? pv / vv : null);
  }
  return out;
}
function computeIndicators(bars) {
  const c = bars.map(b => b.close);
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const macd = c.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  const sig = ema(macd, 9);
  const ind = {
    e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200), rsi: rsi(c), atr: atr(bars),
    bb: bollinger(c), vwap: vwap(bars),
    hist: macd.map((m, i) => m != null && sig[i] != null ? m - sig[i] : null),
  };
  ind.score = c.map((_, i) => biasScore(bars, ind, i));
  return ind;
}
// Trend/momentum composite: -5 (strong bearish) … +5 (strong bullish)
function biasScore(bars, ind, i) {
  const { e20, e50, e200, rsi: r, hist } = ind;
  if (i < 5 || e50[i] == null || e20[i - 5] == null || r[i] == null || hist[i] == null) return null;
  let s = 0;
  s += bars[i].close > e50[i] ? 1 : -1;
  if (e200[i] != null) s += e50[i] > e200[i] ? 1 : -1;
  s += e20[i] > e20[i - 5] ? 1 : -1;
  s += r[i] > 55 ? 1 : r[i] < 45 ? -1 : 0;
  s += hist[i] > 0 ? 1 : -1;
  return s;
}
const biasLabel = s => s == null ? '—' : s >= 2 ? 'Bullish' : s <= -2 ? 'Bearish' : 'Neutral';

// Support/resistance zones.
// 1. Swing pivots that produced a real reaction (>= 0.8 ATR move away).
// 2. Pivots within 0.35 ATR are merged into one zone (kept thin: 0.14–0.36 ATR tall).
// 3. Each zone is replayed against later closed candles: a zone that price closed
//    through more than once is stale and dropped; one clean break flips its role.
// 4. Zones untouched for a long time are dropped; the strongest 3 per side are kept.
function srZones(bars, atrArr) {
  const n = bars.length, last = n - 1, A = atrArr[last];
  if (n < 60 || !A) return { res: [], sup: [] };
  const look = Math.min(last, 400), start = last - look, k = 3, px = bars[last].close;
  const piv = [];
  for (let i = Math.max(start, k + 10); i < last - k; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= k; j++) {
      if (bars[i].high < bars[i - j].high || bars[i].high <= bars[i + j].high) isH = false;
      if (bars[i].low > bars[i - j].low || bars[i].low >= bars[i + j].low) isL = false;
    }
    const a = atrArr[i] || A, from = Math.max(0, i - 10), to = Math.min(last - 1, i + 10);
    if (isH) {
      let lo = Infinity; for (let j = from; j <= to; j++) if (j !== i) lo = Math.min(lo, bars[j].low);
      if (bars[i].high - lo >= 0.8 * a) piv.push({ i, p: bars[i].high, t: 'H' });
    }
    if (isL) {
      let hi = -Infinity; for (let j = from; j <= to; j++) if (j !== i) hi = Math.max(hi, bars[j].high);
      if (hi - bars[i].low >= 0.8 * a) piv.push({ i, p: bars[i].low, t: 'L' });
    }
  }
  piv.sort((x, y) => x.p - y.p);
  const groups = [];
  for (const q of piv) {
    const g = groups[groups.length - 1];
    if (g && q.p - g.sum / g.m.length <= 0.35 * A) { g.m.push(q); g.sum += q.p; } else groups.push({ m: [q], sum: q.p });
  }
  const zones = [];
  for (const g of groups) {
    const ps = g.m.map(q => q.p), mid = g.sum / ps.length;
    const half = Math.min(0.18 * A, Math.max(0.07 * A, (Math.max(...ps) - Math.min(...ps)) / 2 + 0.04 * A));
    const lo = mid - half, hi = mid + half;
    const members = g.m.sort((x, y) => x.i - y.i), first = members[0].i, memberSet = new Set(members.map(q => q.i));
    // Replay closed candles after the zone formed. Only behaviour since the most recent
    // break counts as evidence; older touches earn a small history credit.
    let side = members[0].t === 'H' ? -1 : 1, crosses = [], prevTouch = first;
    const reacts = [];
    for (let i = first + 1; i < last; i++) {
      const c = bars[i].close, sd = c > hi + 0.1 * A ? 1 : c < lo - 0.1 * A ? -1 : 0;
      if (sd && sd !== side) { crosses.push(i); side = sd; }
      const touched = bars[i].low <= hi && bars[i].high >= lo;
      if (memberSet.has(i)) prevTouch = i;
      else if (touched && sd === side && i - prevTouch >= 3) { reacts.push(i); prevTouch = i; }
    }
    const lastCross = crosses.length ? crosses[crosses.length - 1] : -1;
    if (crosses.filter(i => i > last - 40).length >= 2) continue; // price is chopping through it now
    const eTouch = members.filter(q => q.i > lastCross).length + reacts.filter(i => i > lastCross).length;
    const oldTouch = members.length + reacts.length - eTouch;
    const lastTouch = Math.max(members[members.length - 1].i, reacts.length ? reacts[reacts.length - 1] : 0);
    const flipped = crosses.length > 0;
    if (eTouch === 0) {
      if (!flipped || last - lastCross > 100 || oldTouch < 2) continue; // only fresh breaks of real levels count
    } else if (eTouch < 2 && oldTouch === 0 && last - first > look * 0.75) continue; // lone, very old swing
    const touches = eTouch + Math.min(oldTouch, 3);
    const dist = Math.max(0, px > hi ? px - hi : lo - px) / A;
    if (dist > 8) continue;
    const score = eTouch * 2 + Math.min(oldTouch, 4) * 0.5 + (flipped && eTouch ? 1.5 : 0)
      + 2 * Math.max(0, 1 - (last - Math.max(lastTouch, lastCross)) / look) - dist * 0.5;
    zones.push({ lo, hi, price: mid, touches, flipped, from: lastCross > first ? lastCross : first, score });
  }
  const pick = arr => { // best first, skipping zones that would visually crowd a stronger one
    const out = [];
    for (const z of arr.sort((x, y) => y.score - x.score)) {
      if (out.length < 3 && out.every(o => z.lo - o.hi > 0.5 * A || o.lo - z.hi > 0.5 * A)) out.push(z);
    }
    return out;
  };
  return {
    res: pick(zones.filter(z => z.lo > px)).sort((x, y) => x.lo - y.lo),
    sup: pick(zones.filter(z => z.hi < px)).sort((x, y) => y.hi - x.hi),
    inside: zones.filter(z => z.lo <= px && z.hi >= px).sort((x, y) => y.score - x.score).slice(0, 1),
  };
}

// ---------- charts ----------
const LWC = LightweightCharts;
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const COL = { up: cssVar('--up'), down: cssVar('--down'), muted: cssVar('--muted'), accent: cssVar('--accent'), gold: cssVar('--gold') };
const pad = n => String(n).padStart(2, '0');
const baseOpts = {
  autoSize: true,
  layout: { background: { type: 'solid', color: cssVar('--bg') }, textColor: cssVar('--muted'), fontFamily: 'system-ui, Segoe UI, sans-serif' },
  grid: { vertLines: { color: cssVar('--grid') }, horzLines: { color: cssVar('--grid') } },
  crosshair: { mode: LWC.CrosshairMode.Normal },
  rightPriceScale: { borderColor: cssVar('--line'), minimumWidth: 72 },
  timeScale: {
    borderColor: cssVar('--line'), timeVisible: true, secondsVisible: false, rightOffset: 8,
    tickMarkFormatter: (t, type) => {
      const d = new Date(t * 1000);
      if (type === 0) return String(d.getFullYear());
      if (type === 1) return d.toLocaleString('en-US', { month: 'short' });
      if (type === 2) return String(d.getDate());
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    },
  },
  localization: { timeFormatter: t => new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) },
};
const chart = LWC.createChart($('#mainChart'), baseOpts);
const candleSeries = chart.addCandlestickSeries({
  upColor: COL.up, downColor: COL.down, borderVisible: false, wickUpColor: COL.up, wickDownColor: COL.down,
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});
candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });
const volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
const lineOpts = color => ({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const indSeries = {
  ema20: [chart.addLineSeries(lineOpts('#f6c344'))],
  ema50: [chart.addLineSeries(lineOpts('#4aa3ff'))],
  ema200: [chart.addLineSeries({ ...lineOpts('#c77dff'), lineWidth: 2 })],
  vwap: [chart.addLineSeries({ ...lineOpts('#ff9f43'), lineStyle: LWC.LineStyle.Dashed })],
  bb: [chart.addLineSeries(lineOpts('#6f7d93')), chart.addLineSeries({ ...lineOpts('#6f7d93'), lineStyle: LWC.LineStyle.Dotted }), chart.addLineSeries(lineOpts('#6f7d93'))],
};
// Draws S/R zones as small filled rectangles from the candle where each zone formed
// to just past the latest candle.
class ZonePrimitive {
  constructor() { this.zones = []; this.view = new ZoneView(this); }
  attached({ chart: c, series, requestUpdate }) { this.chart = c; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  set(zones) { this.zones = zones; if (this.requestUpdate) this.requestUpdate(); }
  updateAllViews() { this.view.update(); }
  paneViews() { return [this.view]; }
}
class ZoneView {
  constructor(src) { this.src = src; }
  update() {}
  zOrder() { return 'bottom'; }
  renderer() {
    const { chart: c, series, zones } = this.src;
    return {
      draw(target) {
        if (!c || !zones.length) return;
        const ts = c.timeScale(), right = ts.logicalToCoordinate(candles.length - 1 + 4);
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          ctx.save();
          ctx.font = '600 10px system-ui, Segoe UI, sans-serif';
          for (const z of zones) {
            const x1 = ts.logicalToCoordinate(z.from), y1 = series.priceToCoordinate(z.hi), y2 = series.priceToCoordinate(z.lo);
            if (x1 == null || right == null || y1 == null || y2 == null) continue;
            const res = z.kind === 'R', col = res ? '239,83,80' : '38,166,154';
            const left = Math.max(0, x1), w = Math.min(mediaSize.width, right) - left, top = Math.min(y1, y2), h = Math.max(3, Math.abs(y2 - y1));
            if (w <= 0) continue;
            ctx.fillStyle = `rgba(${col},${z.active ? 0.30 : 0.16})`;
            ctx.fillRect(left, top, w, h);
            ctx.strokeStyle = `rgba(${col},0.85)`;
            ctx.lineWidth = 1;
            ctx.setLineDash(z.flipped ? [4, 3] : []);
            ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.max(1, Math.round(w) - 1), Math.max(1, Math.round(h) - 1));
            const label = `${res ? 'R' : 'S'}${z.flipped ? ' flip' : ''} ×${z.touches}`;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = `rgba(${col},1)`;
            ctx.fillText(label, Math.min(mediaSize.width, right) - tw - 4, res ? top - 3 : top + h + 11);
          }
          ctx.restore();
        });
      },
    };
  }
}
const zonePrim = new ZonePrimitive();
candleSeries.attachPrimitive(zonePrim);

// Fractional bar index for a timestamp (continues past the last candle), and back.
function timeToLogical(t) {
  const n = candles.length;
  if (!n) return null;
  const last = candles[n - 1].time;
  if (t >= last) return n - 1 + (t - last) / TF[ui.tf].sec;
  if (t <= candles[0].time) return 0;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles[mid].time <= t) lo = mid; else hi = mid - 1; }
  return lo + (t - candles[lo].time) / (candles[lo + 1].time - candles[lo].time);
}
function logicalToTime(l) {
  const n = candles.length, i = Math.round(l);
  if (i <= 0) return candles[0].time;
  return i < n ? candles[i].time : candles[n - 1].time + (i - (n - 1)) * TF[ui.tf].sec;
}
const boxRole = d => lastPrice == null ? 'S' : d.hi < lastPrice ? 'S' : d.lo > lastPrice ? 'R' : 'IN';
// Your own S/R boxes: green below price (support), red above (resistance), gold while price is inside.
class BoxPrimitive {
  constructor() { this.boxes = []; this.draft = null; }
  attached({ chart: c, series, requestUpdate }) { this.chart = c; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  set(boxes) { this.boxes = boxes; if (this.requestUpdate) this.requestUpdate(); }
  setDraft(d) { this.draft = d; if (this.requestUpdate) this.requestUpdate(); }
  updateAllViews() {}
  paneViews() { return [this]; }
  zOrder() { return 'bottom'; }
  renderer() {
    const { chart: c, series, boxes, draft } = this;
    return {
      draw(target) {
        if (!c || !candles.length) return;
        const ts = c.timeScale(), rightL = candles.length - 1 + 4;
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          const rect = (l1, l2, lo, hi, col, alpha, dash) => {
            const xa = ts.logicalToCoordinate(l1), xb = ts.logicalToCoordinate(l2), ya = series.priceToCoordinate(hi), yb = series.priceToCoordinate(lo);
            if (xa == null || xb == null || ya == null || yb == null) return null;
            const left = Math.max(-2, Math.min(xa, xb)), right = Math.min(mediaSize.width + 2, Math.max(xa, xb)), top = Math.min(ya, yb), h = Math.max(3, Math.abs(yb - ya));
            if (right <= left) return null;
            ctx.fillStyle = `rgba(${col},${alpha})`;
            ctx.fillRect(left, top, right - left, h);
            ctx.strokeStyle = `rgba(${col},0.95)`; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
            ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(right - left) - 1, Math.round(h) - 1);
            return { left, top, h };
          };
          ctx.save();
          ctx.font = '700 10px system-ui, Segoe UI, sans-serif';
          for (const d of boxes) {
            const role = boxRole(d), col = role === 'S' ? '38,166,154' : role === 'R' ? '239,83,80' : '232,184,74';
            const r = rect(timeToLogical(d.t1), d.extend ? rightL : timeToLogical(d.t2), d.lo, d.hi, col, role === 'IN' ? 0.32 : 0.22, []);
            if (!r) continue;
            ctx.fillStyle = `rgba(${col},1)`;
            ctx.fillText(`${d.src || 'My'} ${role === 'IN' ? 'zone' : role} ${fmt(d.lo)}–${fmt(d.hi)}`, Math.max(4, r.left + 4), r.top - 4);
          }
          if (draft) rect(draft.l1, draft.l2, draft.lo, draft.hi, '74,163,255', 0.15, [5, 4]);
          ctx.restore();
        });
      },
    };
  }
}
const boxPrim = new BoxPrimitive();
candleSeries.attachPrimitive(boxPrim);
const rsiChart = LWC.createChart($('#rsiChart'), baseOpts);
const rsiSeries = rsiChart.addLineSeries({ color: '#b38cff', lineWidth: 1, priceLineVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
[70, 30].forEach(p => rsiSeries.createPriceLine({ price: p, color: COL.muted, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: false }));

// keep both panes scrolled/zoomed together
let syncing = false;
const syncRange = (from, to) => from.timeScale().subscribeVisibleLogicalRangeChange(r => {
  if (syncing || !r) return;
  syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
});
syncRange(chart, rsiChart); syncRange(rsiChart, chart);

const toLine = arr => arr.map((v, i) => v == null ? null : { time: candles[i].time, value: v }).filter(Boolean);
const volPoint = b => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(38,166,154,.35)' : 'rgba(239,83,80,.35)' });

function applyVisibility() {
  for (const [k, list] of Object.entries(indSeries)) list.forEach(s => s.applyOptions({ visible: !!ui[k] }));
  $('#rsiChart').classList.toggle('hidden', !ui.rsi);
  chart.applyOptions({ timeScale: { visible: !ui.rsi } });
  $$('#inds button').forEach(b => b.classList.toggle('on', !!ui[b.dataset.ind]));
  $$('#tools [data-toggle]').forEach(b => b.classList.toggle('on', !!ui[b.dataset.toggle]));
}

function onHistory() {
  candleSeries.setData(candles);
  volSeries.setData(candles.map(volPoint));
  onPrice(candles[candles.length - 1].close);
  recalc();
  renderDrawings();
  chart.timeScale().setVisibleLogicalRange({ from: candles.length - 150, to: candles.length + 8 });
}

// Every trade updates (or opens) the current candle.
function onTick({ price, qty, ms }) {
  const sec = Math.floor(ms / 1000);
  if ((settings.spotHours || feed.key === 'spot') && !spotOpen(sec)) { setStatus('spot market closed', 'warn'); return; }
  const spotMode = feed.key === 'spot';
  if (spotMode && !basisSamples.length && !feed.seeded) { basis = r2(raw[raw.length - 1].close - price); feed.seeded = true; } // until gold-api calibrates
  noteRaw(price, ms);
  const p = spotMode ? price + basis : price;
  const t = spotMode ? feed.phase + Math.floor((sec - feed.phase) / TF[ui.tf].sec) * TF[ui.tf].sec : bucketFor(ui.tf, sec);
  let last = raw[raw.length - 1];
  if (t < last.time) return;
  if (t > last.time) raw.push(last = { time: t, open: p, high: p, low: p, close: p, volume: 0 });
  else { last.close = p; if (p > last.high) last.high = p; if (p < last.low) last.low = p; }
  if (!spotMode) last.volume += qty;
  if ($('#status').classList.contains('warn')) setStatus('live', 'ok');
  onLiveBar(shift(last));
}
function onLiveBar(b) {
  const last = candles[candles.length - 1];
  if (last && b.time < last.time) return;
  if (last && b.time === last.time) candles[candles.length - 1] = b; else candles.push(b);
  candleSeries.update(b);
  volSeries.update(volPoint(b));
  onPrice(b.close);
  scheduleRecalc();
}

let recalcTimer = null;
function scheduleRecalc() {
  if (!recalcTimer) recalcTimer = setTimeout(() => { recalcTimer = null; recalc(); }, 1000);
}
function recalc() {
  if (candles.length < 30) return;
  calc = computeIndicators(candles);
  indSeries.ema20[0].setData(toLine(calc.e20));
  indSeries.ema50[0].setData(toLine(calc.e50));
  indSeries.ema200[0].setData(toLine(calc.e200));
  indSeries.vwap[0].setData(toLine(calc.vwap));
  indSeries.bb[0].setData(toLine(calc.bb.up)); indSeries.bb[1].setData(toLine(calc.bb.mid)); indSeries.bb[2].setData(toLine(calc.bb.lo));
  rsiSeries.setData(candles.map((c, i) => calc.rsi[i] == null ? { time: c.time } : { time: c.time, value: calc.rsi[i] }));
  calc.market = marketState();
  renderMarket();
  renderSR();
  renderMarkers();
  renderOpenTrades();
  if (ui.tab === 'plan' && plan.market && Date.now() - lastPlanRun > 5000) runPlan();
}

// ---------- header quote, legend ----------
function onPrice(px) {
  const el = $('#lastPx');
  if (lastPrice != null && px !== lastPrice) {
    el.classList.remove('flash-up', 'flash-down');
    el.classList.add(px > lastPrice ? 'flash-up' : 'flash-down');
  }
  lastPrice = px;
  el.textContent = fmt(px);
  document.title = fmt(px) + ' · XAU/USD · GoldTerm';
  const lastT = candles[candles.length - 1].time;
  let ref = candles[0];
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= lastT - 86400) { ref = candles[i]; break; }
  const ch = px - ref.close;
  const c = $('#chg'); c.className = 'chg ' + sgn(ch);
  c.textContent = `${ch >= 0 ? '+' : ''}${fmt(ch)} (${ch >= 0 ? '+' : ''}${(ch / ref.close * 100).toFixed(2)}%) 24h`;
  checkAutoClose(px);
  checkAlerts(px);
  if (!legendHover) renderLegend(candles[candles.length - 1]);
}
let legendHover = false;
function renderLegend(b) {
  if (!b) return;
  const ch = b.close - b.open, cls = sgn(ch);
  const left = barEnd(b.time) - Math.floor(Date.now() / 1000);
  const cd = !legendHover && left > 0 && left <= TF[ui.tf].sec ? `<span class="k">closes in ${left >= 3600 ? Math.floor(left / 3600) + 'h ' : ''}${pad(Math.floor(left % 3600 / 60))}:${pad(left % 60)}</span>` : '';
  $('#legend').innerHTML = `<span class="t">XAU/USD · ${ui.tf.toUpperCase()}</span>` +
    ['O', 'H', 'L', 'C'].map((k, i) => `<span><span class="k">${k}</span> <span class="${cls}">${fmt(b[['open', 'high', 'low', 'close'][i]])}</span></span>`).join('') +
    `<span class="${cls}">${ch >= 0 ? '+' : ''}${fmt(ch)} (${(ch / b.open * 100).toFixed(2)}%)</span>${cd}`;
}
chart.subscribeCrosshairMove(p => {
  const d = p.time && p.seriesData.get(candleSeries);
  legendHover = !!d;
  renderLegend(d || candles[candles.length - 1]);
});
setInterval(() => { if (!legendHover && candles.length) renderLegend(candles[candles.length - 1]); }, 1000);

// ---------- alerts ----------
// Fires when live price enters a support/resistance zone or crosses one of your
// horizontal lines. A zone re-arms only after price moves 0.5 ATR away from it.
let alertLog = store.get('alertLog', []);
let firedZones = [], seeded = false, prevAlertPx = null, audioCtx = null;
const lineFired = new Map(), boxAlert = new Map();
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, k) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime + k * 0.18;
      o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
  } catch { /* audio unavailable */ }
}
document.addEventListener('pointerdown', () => { // browsers only allow sound after a click
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* ignore */ }
}, { once: true });
let titleFlash = null;
function fireAlert(kind, text) {
  const entry = { t: Date.now(), kind, text };
  alertLog.unshift(entry); alertLog = alertLog.slice(0, 20); store.set('alertLog', alertLog);
  beep();
  toast('🔔 ' + text, 9000);
  try { if ('Notification' in window && Notification.permission === 'granted') new Notification('Gold alert · ' + fmt(lastPrice), { body: text, tag: 'goldterm-' + kind, renotify: true }); } catch { /* ignore */ }
  clearInterval(titleFlash);
  let n = 0;
  titleFlash = setInterval(() => { document.title = n++ % 2 ? '🔔 ' + text : fmt(lastPrice) + ' · XAU/USD'; if (n > 12) clearInterval(titleFlash); }, 800);
  renderMarket();
}
function checkAlerts(px) {
  const m = calc && calc.market;
  if (!ui.alerts || !m || !m.atr) { prevAlertPx = px; return; }
  const A = m.atr;
  const zones = [...m.sr.res.map(z => ({ ...z, kind: 'R' })), ...m.sr.sup.map(z => ({ ...z, kind: 'S' })), ...m.sr.inside.map(z => ({ ...z, kind: px >= z.price ? 'S' : 'R' }))];
  firedZones = firedZones.filter(f => px >= f.lo - 0.5 * A && px <= f.hi + 0.5 * A); // re-arm once price has left
  for (const z of zones) {
    if (px < z.lo || px > z.hi) continue;
    if (firedZones.some(f => f.lo <= z.hi + 0.3 * A && f.hi >= z.lo - 0.3 * A)) continue;
    firedZones.push({ lo: z.lo, hi: z.hi });
    if (!seeded) continue; // price was already inside when the app opened: no alert
    const role = z.kind === 'R' ? 'resistance' : 'support';
    fireAlert('zone', `Price ${fmt(px)} entered ${role}${z.flipped ? ' (flipped)' : ''} ${fmt(z.lo)}–${fmt(z.hi)} ×${z.touches} on ${ui.tf.toUpperCase()}`);
  }
  seeded = true;
  for (const d of drawings) {
    if (d.type !== 'r' || !(d.extend || d.t2 >= candles[candles.length - 1].time)) continue;
    const inBox = px >= d.lo && px <= d.hi;
    let st = boxAlert.get(d.id);
    if (!st) { boxAlert.set(d.id, st = { armed: !inBox }); continue; } // no alert for a box price is already in
    if (inBox && st.armed) {
      st.armed = false;
      const role = prevAlertPx != null && prevAlertPx > d.hi ? 'support' : prevAlertPx != null && prevAlertPx < d.lo ? 'resistance' : 'zone';
      fireAlert('box', `Price ${fmt(px)} entered your ${role} box ${fmt(d.lo)}–${fmt(d.hi)}`);
    } else if (!inBox && (px < d.lo - 0.3 * A || px > d.hi + 0.3 * A)) st.armed = true;
  }
  if (prevAlertPx != null) for (const d of drawings) {
    if (d.type !== 'h') continue;
    const crossed = (prevAlertPx < d.price && px >= d.price) || (prevAlertPx > d.price && px <= d.price);
    if (crossed && Date.now() - (lineFired.get(d.price) || 0) > 300000) {
      lineFired.set(d.price, Date.now());
      fireAlert('line', `Price crossed your line at ${fmt(d.price)} (${px > prevAlertPx ? 'up' : 'down'})`);
    }
  }
  prevAlertPx = px;
}

// ---------- market analysis ----------
function marketState() {
  const i = candles.length - 1, b = candles[i], A = calc.atr[i], s = calc.score[i];
  const sig = [];
  const add = (v, text) => sig.push({ v, text });
  if (calc.e50[i] != null) add(b.close > calc.e50[i] ? 1 : -1, `Price ${b.close > calc.e50[i] ? 'above' : 'below'} EMA50 (${fmt(calc.e50[i])})`);
  if (calc.e200[i] != null) add(calc.e50[i] > calc.e200[i] ? 1 : -1, `EMA50 ${calc.e50[i] > calc.e200[i] ? 'above' : 'below'} EMA200 — ${calc.e50[i] > calc.e200[i] ? 'up' : 'down'}trend structure`);
  if (calc.e20[i - 5] != null) add(calc.e20[i] > calc.e20[i - 5] ? 1 : -1, `EMA20 sloping ${calc.e20[i] > calc.e20[i - 5] ? 'up' : 'down'}`);
  const r = calc.rsi[i];
  add(r > 70 ? 0 : r > 55 ? 1 : r < 30 ? 0 : r < 45 ? -1 : 0,
    r > 70 ? `RSI ${r.toFixed(0)} — overbought, late to buy` : r < 30 ? `RSI ${r.toFixed(0)} — oversold, late to sell` : `RSI ${r.toFixed(0)} — ${r > 55 ? 'bullish' : r < 45 ? 'bearish' : 'neutral'} momentum`);
  if (calc.hist[i] != null) add(calc.hist[i] > 0 ? 1 : -1, `MACD histogram ${calc.hist[i] > 0 ? 'positive' : 'negative'}${Math.sign(calc.hist[i]) !== Math.sign(calc.hist[i - 1]) ? ' (just crossed)' : ''}`);
  const bbw = calc.bb.up[i] - calc.bb.lo[i];
  if (b.close > calc.bb.up[i]) add(0, 'Closing above upper Bollinger band — stretched');
  else if (b.close < calc.bb.lo[i]) add(0, 'Closing below lower Bollinger band — stretched');
  const atrs = calc.atr.slice(-100).filter(ok), avgAtr = atrs.reduce((a, v) => a + v, 0) / atrs.length;
  return {
    price: b.close, score: s, bias: biasLabel(s), rsi: r, atr: A, avgAtr, bbw,
    vol: A > avgAtr * 1.2 ? 'Expanding' : A < avgAtr * 0.8 ? 'Contracting' : 'Normal',
    sr: srZones(candles, calc.atr), sig, session: sessionOf(Date.now()),
  };
}

let mtf = {};
async function refreshMTF() {
  const key = feed.key;
  if (!key) return;
  const src = key === 'spot' ? SOURCES.bnFut : SOURCES[key]; // spare Twelve Data credits
  const out = {};
  for (const tf of ['15m', '1h', '4h', '1d']) {
    try {
      const bars = await src.history(tf, 250); // bias is unaffected by a constant price offset
      const ind = computeIndicators(bars), i = bars.length - 1;
      out[tf] = { score: ind.score[i], rsi: ind.rsi[i] };
    } catch { /* skip this timeframe */ }
  }
  if (key === feed.key) { mtf = out; renderMarket(); }
}
setInterval(refreshMTF, 120000);

// ---------- strategy signals (London open breakout + S/R candlestick on 15m, liquidity sweep + compression on 5m, from strategies.js) ----------
// Always computed on 15m / 5m candles, whatever timeframe the chart shows; refreshed every minute.
const strat = { signals: [], watches: [], bias: null, at: 0 };
async function refreshStrategies() {
  if (!window.GoldStrategies || !feed.key) return;
  try {
    const spotMode = feed.key === 'spot', src = spotMode ? SOURCES.bnFut : SOURCES[feed.key];
    const off = (+settings.offset || 0) + (spotMode || settings.spotAlign ? basis : 0);
    const bars = (await src.history('15m', 4500)).map(b => shift(b, off)); // long history so the 1H EMA 200 has settled
    const from = Math.floor(Date.now() / 1000) - 7 * 86400, res = GoldStrategies.analyze(bars, { fromTime: from });
    let bars5 = [];
    if (GoldStrategies.analyze5) {
      bars5 = (await src.history('5m', 14000)).map(b => shift(b, off)); // ~9.5k after the spot-hours filter; analyze5 needs 7k
      const r5 = GoldStrategies.analyze5(bars5, { fromTime: from });
      res.signals = res.signals.concat(r5.signals).sort((a, b) => a.time - b.time); res.watches = res.watches.concat(r5.watches);
    }
    for (const s of res.signals) settleSignal(s, s.tf === 300 ? bars5 : bars);
    Object.assign(strat, res, { at: Date.now() });
    renderMarkers(); renderMarket();
  } catch { /* keep the last result */ }
}
setInterval(refreshStrategies, 60000);
// outcome of a signal on its own candles, same rules as tools/forward-test.mjs (stop checked first, time exit after s.hold or 48h)
function settleSignal(s, bars) {
  s.exitTime = null; s.result = null;
  const hold = s.hold || 48 * 3600;
  for (const b of bars) {
    if (b.time < s.entryTime || b === bars[bars.length - 1]) continue; // the forming candle can't settle a trade yet
    const hs = s.dir > 0 ? b.low <= s.stop : b.high >= s.stop, ht = s.dir > 0 ? b.high >= s.tp : b.low <= s.tp;
    if (hs || ht || b.time - s.entryTime >= hold) { s.exitTime = b.time; s.result = hs ? 'STOP' : ht ? 'TARGET' : 'TIME'; return; }
  }
}
function strategyPanel() {
  const label = s => s === 'ORB' ? 'London breakout' : s === 'SWP' ? '5m liquidity sweep' : s === 'CMP' ? '5m compression' : 'S/R + candle';
  const recent = strat.signals.slice(-5).reverse();
  const fw = window.FORWARD && window.FORWARD.stats;
  const fwRow = (k, v) => v ? `<tr><td>${label(k)}</td><td class="r">${v.closed}</td><td class="r">${v.wins}</td><td class="r ${sgn(v.totalR)}">${v.totalR >= 0 ? '+' : ''}${v.totalR.toFixed(2)}R</td><td class="r ${sgn(v.ret)}">${pct(v.ret, 1)}</td><td class="r">${pct(v.maxDD, 1)}</td></tr>` : '';
  return `<h4>Strategy signals (15m + 5m) ${strat.at ? `<span class="muted">· updated ${new Date(strat.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : ''}</h4>
    ${strat.watches.map(w => `<div class="note warn">⚠️ ${esc(w.text)}</div>`).join('')}
    ${recent.length ? `<table><tr><th>Signal</th><th class="r">Entry</th><th class="r">Stop</th><th class="r">Target</th><th></th></tr>
      ${recent.map(s => `<tr title="${esc(s.note)}"><td class="${s.dir > 0 ? 'up' : 'down'}">${s.dir > 0 ? 'BUY' : 'SELL'} · ${label(s.strategy)}<br><span class="muted">${new Date(s.time * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></td>
        <td class="r">${fmt(s.entry)}</td><td class="r">${fmt(s.stop)}</td><td class="r">${fmt(s.tp)}</td><td><button class="mini" data-sig="${strat.signals.indexOf(s)}" title="Open in planner">↗</button></td></tr>`).join('')}</table>`
      : '<p class="hint">No signals in the last 7 days.</p>'}
    ${fw ? `<h4>Forward test (paper, ${settings.risk || 2}% risk) <span class="muted">· since ${new Date(window.FORWARD.since).toLocaleDateString()}</span></h4>
      <table><tr><th></th><th class="r">Closed</th><th class="r">Wins</th><th class="r">Total</th><th class="r">Return</th><th class="r">Max DD</th></tr>${fwRow('ORB', fw.ORB)}${fwRow('SRC', fw.SRC)}${fwRow('SWP', fw.SWP)}${fwRow('CMP', fw.CMP)}</table>
      <p class="hint">Run by tools/forward-test.mjs; refresh the page to update.</p>` : ''}`;
}

function renderMarket() {
  if (!calc || !calc.market) return;
  const m = calc.market, sc = m.score ?? 0;
  const lvl = (l, kind) => `<tr><td class="${kind === 'R' ? 'down' : 'up'}">${kind}${l.flipped ? ' ↺' : ''}</td><td class="r">${fmt(l.lo)} – ${fmt(l.hi)}</td><td class="r muted">${((kind === 'R' ? l.lo - m.price : m.price - l.hi) / m.atr).toFixed(1)} ATR</td><td class="r muted">${l.touches}×</td></tr>`;
  const mtfRows = Object.entries(mtf).map(([tf, v]) => `<tr><td>${tf.toUpperCase()}</td><td class="${v.score >= 2 ? 'up' : v.score <= -2 ? 'down' : ''}">${biasLabel(v.score)}</td><td class="r">${v.score ?? '—'}</td><td class="r">${fmt(v.rsi, 0)}</td></tr>`).join('');
  const idea = marketIdea(m);
  const recent = alertLog.filter(a => Date.now() - a.t < 6 * 3600e3).slice(0, 5);
  $('#tab-market').innerHTML = `
    ${recent.length ? `<h4>Recent alerts</h4>${recent.map(a => `<div class="note warn"><span class="muted">${new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> ${esc(a.text)}</div>`).join('')}` : ''}
    <div class="bias ${m.bias}">
      <div><div class="muted" style="font-size:11px">${ui.tf.toUpperCase()} BIAS</div><div class="label">${m.bias}</div></div>
      <div style="text-align:right"><div class="meter"><i style="left:${(sc + 5) * 10}%"></i></div><div class="muted" style="font-size:11px;margin-top:6px">score ${sc > 0 ? '+' : ''}${sc} / ±5</div></div>
    </div>
    <div class="stats">
      <div class="stat"><span>ATR(14)</span><b>${fmt(m.atr)}</b> <small>${pct(m.atr / m.price, 2)}</small></div>
      <div class="stat"><span>Volatility</span><b>${m.vol}</b> <small>${(m.atr / m.avgAtr).toFixed(2)}× avg</small></div>
      <div class="stat"><span>RSI(14)</span><b>${fmt(m.rsi, 1)}</b></div>
      <div class="stat"><span>Session (UTC)</span><b style="font-size:13px">${m.session}</b></div>
    </div>
    <h4>Signals</h4>
    <ul class="signals">${m.sig.map(s => `<li><span class="dot ${sgn(s.v)}">${s.v > 0 ? '▲' : s.v < 0 ? '▼' : '•'}</span>${esc(s.text)}</li>`).join('')}</ul>
    <h4>Support / resistance zones</h4>
    <table>${m.sr.res.slice().reverse().map(l => lvl(l, 'R')).join('')}
      <tr><td class="muted">◆</td><td class="r"><b>${fmt(m.price)}</b></td><td class="r muted">${m.sr.inside.length ? 'inside zone' : 'price'}</td><td></td></tr>
      ${m.sr.sup.map(l => lvl(l, 'S')).join('')}</table>
    ${mtfRows ? `<h4>Multi-timeframe</h4><table><tr><th>TF</th><th>Bias</th><th class="r">Score</th><th class="r">RSI</th></tr>${mtfRows}</table>` : ''}
    ${strategyPanel()}
    <h4>Setup idea</h4>
    <div class="card">${idea.html}${idea.plan ? '<div class="btn-row" style="margin-bottom:0"><button class="primary" id="ideaBtn">Open in planner</button></div>' : ''}</div>`;
  $$('[data-sig]').forEach(b => b.onclick = () => {
    const s = strat.signals[+b.dataset.sig];
    clearTemplate(); Object.assign(plan, { dir: s.dir > 0 ? 'long' : 'short', entry: r2(s.entry), sl: r2(s.stop), tp: r2(s.tp), market: false });
    syncPlanInputs(); setTab('plan'); runPlan();
  });
  const ib = $('#ideaBtn');
  if (ib) ib.onclick = () => { clearTemplate(); Object.assign(plan, idea.plan, { market: true }); syncPlanInputs(); setTab('plan'); runPlan(); };
}
function marketIdea(m) {
  const aligned = Object.values(mtf).filter(v => v.score != null);
  const htfAgree = aligned.length ? aligned.filter(v => Math.sign(v.score) === Math.sign(m.score)).length : null;
  if (m.bias === 'Neutral') return { html: `<p style="margin:0">No directional edge on ${ui.tf.toUpperCase()} — conditions look range-bound. Waiting for a break of ${m.sr.res[0] ? fmt(m.sr.res[0].price) : 'resistance'} or ${m.sr.sup[0] ? fmt(m.sr.sup[0].price) : 'support'} is usually better than forcing a trade.</p>` };
  const dir = m.bias === 'Bullish' ? 'long' : 'short';
  const p = smartLevels(dir, m.price);
  const stretched = (dir === 'long' && m.rsi > 70) || (dir === 'short' && m.rsi < 30);
  return {
    plan: p,
    html: `<p style="margin:0 0 6px"><b class="${dir === 'long' ? 'up' : 'down'}">${dir === 'long' ? 'Long' : 'Short'} bias</b> — entry ~${fmt(p.entry)}, stop ${fmt(p.sl)}, target ${fmt(p.tp)} (${(Math.abs(p.tp - p.entry) / Math.abs(p.entry - p.sl)).toFixed(1)}R).</p>
      <p class="muted" style="margin:0">${htfAgree != null ? `${htfAgree}/${aligned.length} timeframes agree. ` : ''}${stretched ? 'Momentum is stretched — a pullback entry is safer than chasing.' : 'Run it through the planner for outcome odds.'}</p>`,
  };
}

// S/R price lines
let srKey = '';
function renderSR() {
  const m = calc && calc.market;
  const zs = ui.sr && m ? [
    ...m.sr.res.map(z => ({ ...z, kind: 'R' })), ...m.sr.sup.map(z => ({ ...z, kind: 'S' })),
    ...m.sr.inside.map(z => ({ ...z, kind: m.price >= z.price ? 'S' : 'R', active: true })),
  ] : [];
  const key = zs.map(z => `${z.kind}${z.lo.toFixed(2)}${z.hi.toFixed(2)}${z.from}${z.touches}${z.active ? 1 : 0}`).join('|');
  if (key === srKey) return;
  srKey = key;
  zonePrim.set(zs);
}

// ---------- drawings & chart clicks ----------
let tool = 'cursor', trendStart = null, rectStart = null;
const drawn = { lines: [], series: [] };
const snapTime = t => {
  if (!candles.length) return t;
  if (t <= candles[0].time) return candles[0].time;
  let lo = 0, hi = candles.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles[mid].time <= t) lo = mid; else hi = mid - 1; }
  return candles[lo].time;
};
function renderDrawings() {
  drawn.lines.forEach(l => candleSeries.removePriceLine(l));
  drawn.series.forEach(s => chart.removeSeries(s));
  drawn.lines = []; drawn.series = [];
  for (const d of drawings) {
    if (d.type === 'h') drawn.lines.push(candleSeries.createPriceLine({ price: d.price, color: COL.gold, lineWidth: 1, lineStyle: LWC.LineStyle.Solid, axisLabelVisible: true }));
    else if (d.type === 't') {
      const a = { time: snapTime(d.a.time), value: d.a.price }, b = { time: snapTime(d.b.time), value: d.b.price };
      if (a.time === b.time) continue;
      const s = chart.addLineSeries({ ...lineOpts(d.src === 'TV' ? '#2962ff' : COL.gold), lineWidth: 2, autoscaleInfoProvider: () => null });
      s.setData(a.time < b.time ? [a, b] : [b, a]);
      drawn.series.push(s);
    }
  }
  boxPrim.set(drawings.filter(d => d.type === 'r'));
}
function setTool(t, hint) {
  tool = t; trendStart = null; rectStart = null; boxPrim.setDraft(null);
  $$('#tools [data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
  $$('[data-pick]').forEach(b => b.classList.toggle('on', 'pick-' + b.dataset.pick === t));
  const h = $('#toolHint'); h.hidden = !hint; h.textContent = hint || '';
}
chart.subscribeClick(p => {
  if (!p.point || tool === 'cursor') return;
  const price = candleSeries.coordinateToPrice(p.point.y);
  if (price == null) return;
  if (tool.startsWith('pick-')) {
    plan[tool.slice(5)] = r2(price);
    clearTemplate();
    if (tool === 'pick-entry') plan.market = false;
    syncPlanInputs(); runPlan(); setTool('cursor');
    return;
  }
  if (tool === 'hline') { drawings.push({ type: 'h', price: r2(price) }); }
  else if (tool === 'trend') {
    if (!p.time) return;
    if (!trendStart) { trendStart = { time: p.time, price }; $('#toolHint').textContent = 'Click the second point'; return; }
    drawings.push({ type: 't', a: trendStart, b: { time: p.time, price } });
  } else if (tool === 'rect') {
    const lg = p.logical ?? (p.time ? timeToLogical(p.time) : null);
    if (lg == null) return;
    if (!rectStart) {
      rectStart = { lg, price };
      $('#toolHint').textContent = 'Click the opposite corner. Finish right of the last candle to keep the box extending.';
      return;
    }
    if (Math.abs(price - rectStart.price) < 0.05) return;
    const l1 = Math.min(lg, rectStart.lg), l2 = Math.max(lg, rectStart.lg);
    drawings.push({
      type: 'r', id: uid(), t1: logicalToTime(l1), t2: logicalToTime(l2), extend: l2 >= candles.length - 1,
      lo: r2(Math.min(price, rectStart.price)), hi: r2(Math.max(price, rectStart.price)),
    });
    toast(`Box ${fmt(Math.min(price, rectStart.price))}–${fmt(Math.max(price, rectStart.price))} added. Double-click it to delete.`);
  }
  store.set('drawings', drawings);
  renderDrawings();
  setTool('cursor');
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') setTool('cursor'); });
// live preview while drawing a box
chart.subscribeCrosshairMove(p => {
  if (tool !== 'rect' || !rectStart || !p.point || p.logical == null) return;
  const price = candleSeries.coordinateToPrice(p.point.y);
  if (price != null) boxPrim.setDraft({ l1: rectStart.lg, l2: p.logical, lo: Math.min(price, rectStart.price), hi: Math.max(price, rectStart.price) });
});
// double-click a box to delete it
chart.subscribeDblClick(p => {
  if (tool !== 'cursor' || !p.point || p.logical == null) return;
  const price = candleSeries.coordinateToPrice(p.point.y);
  const hit = drawings.filter(d => d.type === 'r').reverse().find(d => price >= d.lo && price <= d.hi &&
    p.logical >= timeToLogical(d.t1) - 0.5 && (d.extend || p.logical <= timeToLogical(d.t2) + 0.5));
  if (hit && confirm(`Delete box ${fmt(hit.lo)}–${fmt(hit.hi)}?`)) {
    drawings = drawings.filter(d => d !== hit); store.set('drawings', drawings); renderDrawings();
  }
});

// ---------- trade markers & plan lines ----------
function renderMarkers() {
  if (!candles.length) return;
  const first = candles[0].time, mk = [];
  if (ui.marks) for (const t of trades) {
    const ot = Math.floor(t.openTime / 1000);
    if (ot >= first) mk.push({ time: snapTime(ot), position: t.dir === 'long' ? 'belowBar' : 'aboveBar', color: t.dir === 'long' ? COL.up : COL.down, shape: t.dir === 'long' ? 'arrowUp' : 'arrowDown', text: `${t.dir === 'long' ? 'B' : 'S'} ${t.lots}` });
    if (t.status === 'closed' && t.closeTime && Math.floor(t.closeTime / 1000) >= first) {
      mk.push({ time: snapTime(Math.floor(t.closeTime / 1000)), position: t.dir === 'long' ? 'aboveBar' : 'belowBar', color: COL.muted, shape: 'circle' }); // exit point only: no P&L text or win/loss colour
    }
  }
  // strategy signals (strategies.js): BUY/SELL arrows, and BUY?/SELL? on the forming candle for heads-ups
  for (const s of strat.signals) if (s.time >= first) mk.push({ time: snapTime(s.time), position: s.dir > 0 ? 'belowBar' : 'aboveBar', color: s.dir > 0 ? '#00c853' : '#ff1744', shape: s.dir > 0 ? 'arrowUp' : 'arrowDown', text: `${s.dir > 0 ? 'BUY' : 'SELL'} ${s.strategy}` });
  for (const w of strat.watches) if (w.dir && w.time >= first) mk.push({ time: snapTime(w.time), position: w.dir > 0 ? 'belowBar' : 'aboveBar', color: COL.gold, shape: 'circle', text: `${w.dir > 0 ? 'BUY?' : 'SELL?'} ${w.strategy}` });
  mk.sort((a, b) => a.time - b.time);
  candleSeries.setMarkers(mk);
  renderSignalLevels();
}
// entry / SL / target of the last strategy signals: short segments from entry to exit (to the current candle while
// open). Open signals also get labelled price lines. Closed ones are faded, with no P&L.
const sigLv = { series: [], lines: [], key: '' };
function renderSignalLevels() {
  const list = ui.siglv && candles.length ? strat.signals.filter(s => s.entryTime >= candles[0].time).slice(-8) : [];
  const key = JSON.stringify([list.map(s => [s.time, s.strategy, s.exitTime]), candles.length && candles[0].time, candles.length, ui.siglv]);
  if (key === sigLv.key) return;
  sigLv.key = key;
  sigLv.series.forEach(s => chart.removeSeries(s)); sigLv.lines.forEach(l => candleSeries.removePriceLine(l));
  sigLv.series = []; sigLv.lines = [];
  const last = candles[candles.length - 1];
  for (const s of list) {
    const open = !s.exitTime, a = snapTime(s.entryTime);
    let b = open ? last.time : snapTime(s.exitTime);
    if (b <= a) { const i = candles.findIndex(c => c.time === a); b = candles[i + 1] ? candles[i + 1].time : null; }
    const name = `${s.dir > 0 ? 'BUY' : 'SELL'} ${s.strategy}`;
    for (const [price, rgb, title] of [[s.entry, '74,163,255', 'ENTRY'], [s.stop, '239,83,80', 'SL'], [s.tp, '38,166,154', 'TP']]) {
      const color = `rgb(${rgb})`;
      if (b) {
        const ser = chart.addLineSeries({ ...lineOpts(open ? color : `rgba(${rgb},.6)`), lineWidth: open ? 2 : 1, lineStyle: title === 'ENTRY' ? LWC.LineStyle.Solid : LWC.LineStyle.Dashed, autoscaleInfoProvider: () => null });
        ser.setData([{ time: a, value: price }, { time: b, value: price }]);
        sigLv.series.push(ser);
      }
      if (open) sigLv.lines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dotted, axisLabelVisible: true, title: title === 'ENTRY' ? `${name} ENTRY` : title }));
    }
  }
}
let planLines = [];
function renderPlanLines(valid) {
  planLines.forEach(l => candleSeries.removePriceLine(l));
  planLines = [];
  const add = (price, color, title) => planLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 2, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title }));
  if (valid && ui.tab === 'plan') {
    add(plan.entry, COL.accent, 'ENTRY'); add(plan.sl, COL.down, 'SL'); add(plan.tp, COL.up, 'TP');
  }
  if (ui.marks) for (const t of trades.filter(t => t.status === 'open')) {
    add(t.entry, 'rgba(74,163,255,.6)', `${t.dir === 'long' ? 'B' : 'S'} ${t.lots}`);
    if (ok(t.sl)) add(t.sl, 'rgba(239,83,80,.6)', 'SL');
    if (ok(t.tp)) add(t.tp, 'rgba(38,166,154,.6)', 'TP');
  }
}

// ---------- outcome models ----------
// Bootstrap Monte Carlo: replays randomly drawn historical bars (de-trended) from the entry price.
function monteCarlo(bars, dir, entry, sl, tp, paths = 4000, horizon = 300) {
  const n = Math.min(bars.length - 1, 600), hr = [], lr = [], cr = [];
  for (let i = bars.length - n; i < bars.length; i++) {
    const pc = bars[i - 1].close, b = bars[i];
    hr.push(b.high / pc - 1); lr.push(b.low / pc - 1); cr.push(b.close / pc - 1);
  }
  const mean = cr.reduce((a, v) => a + v, 0) / cr.length;
  const long = dir === 'long';
  let win = 0, loss = 0, open = 0;
  const times = [];
  for (let p = 0; p < paths; p++) {
    let px = entry, res = 0, t = 1;
    for (; t <= horizon; t++) {
      const j = (Math.random() * hr.length) | 0;
      const hi = px * (1 + hr[j] - mean), lo = px * (1 + lr[j] - mean);
      if (long ? lo <= sl : hi >= sl) { res = -1; break; } // stop checked first = conservative
      if (long ? hi >= tp : lo <= tp) { res = 1; break; }
      px *= 1 + cr[j] - mean;
    }
    if (res > 0) win++; else if (res < 0) loss++; else open++;
    if (res) times.push(t);
  }
  times.sort((a, b) => a - b);
  return { win, loss, open, n: paths, p: win + loss ? win / (win + loss) : null, medBars: times.length ? times[times.length >> 1] : null };
}
// Historical analogs: same stop/target distances in ATR units, entered at every past bar.
function analogBacktest(bars, ind, dir, slAtr, tpAtr, curScore, horizon = 300) {
  const s = dir === 'long' ? 1 : -1, all = { w: 0, l: 0 }, reg = { w: 0, l: 0 };
  for (let i = 30; i < bars.length - 1; i++) {
    const A = ind.atr[i];
    if (!A) continue;
    const e = bars[i].close, sl = e - s * slAtr * A, tp = e + s * tpAtr * A;
    let res = 0;
    for (let j = i + 1, end = Math.min(bars.length, i + 1 + horizon); j < end; j++) {
      const b = bars[j];
      if (s > 0 ? b.low <= sl : b.high >= sl) { res = -1; break; }
      if (s > 0 ? b.high >= tp : b.low <= tp) { res = 1; break; }
    }
    if (!res) continue;
    const k = res > 0 ? 'w' : 'l';
    all[k]++;
    const sc = ind.score[i];
    if (curScore != null && sc != null && Math.sign(sc) === Math.sign(curScore)) reg[k]++;
  }
  const p = o => o.w + o.l ? o.w / (o.w + o.l) : null;
  return { all: { ...all, n: all.w + all.l, p: p(all) }, reg: { ...reg, n: reg.w + reg.l, p: p(reg) } };
}
function journalModel(dir) {
  const c = trades.filter(t => t.status === 'closed' && t.dir === dir);
  if (c.length < 5) return { n: c.length, p: null };
  return { n: c.length, p: c.filter(t => t.pnl > 0).length / c.length };
}
function smartLevels(dir, entry) {
  const m = calc.market, A = m.atr, s = dir === 'long' ? 1 : -1;
  const protect = (s > 0 ? m.sr.sup : m.sr.res).find(l => Math.abs(entry - l.price) >= 0.5 * A && Math.abs(entry - l.price) <= 3 * A && s * (entry - l.price) > 0);
  const sl = protect ? (s > 0 ? protect.lo : protect.hi) - s * 0.2 * A : entry - s * 1.5 * A; // just beyond the zone
  const risk = Math.abs(entry - sl);
  const target = (s > 0 ? m.sr.res : m.sr.sup).find(l => s * (l.price - entry) >= 1.5 * risk);
  const tp = target ? (s > 0 ? target.lo : target.hi) - s * 0.05 * A : entry + s * 2 * risk; // just before the zone
  return { dir, entry: r2(entry), sl: r2(sl), tp: r2(tp) };
}

function evaluate(p) {
  const s = p.dir === 'long' ? 1 : -1, errs = [];
  if (!ok(p.entry) || !ok(p.sl) || !ok(p.tp)) errs.push('Enter entry, stop loss and take profit.');
  else {
    if (s * (p.entry - p.sl) <= 0) errs.push(`Stop loss must be ${s > 0 ? 'below' : 'above'} entry for a ${p.dir}.`);
    if (s * (p.tp - p.entry) <= 0) errs.push(`Take profit must be ${s > 0 ? 'above' : 'below'} entry for a ${p.dir}.`);
  }
  if (!(p.lots > 0)) errs.push('Lots must be positive.');
  if (errs.length) return { errs };
  const m = calc.market, A = m.atr;
  const risk = Math.abs(p.entry - p.sl), reward = Math.abs(p.tp - p.entry), rr = reward / risk;
  const riskUsd = risk * p.lots * OZ, rewardUsd = reward * p.lots * OZ;
  const slAtr = risk / A, tpAtr = reward / A;

  const mc = monteCarlo(candles, p.dir, p.entry, p.sl, p.tp);
  const bt = analogBacktest(candles, calc, p.dir, slAtr, tpAtr, m.score);
  const jm = journalModel(p.dir);
  const btUse = bt.reg.n >= 25 ? { ...bt.reg, label: 'History · same regime' } : { ...bt.all, label: 'History · all bars' };
  const parts = [];
  if (mc.p != null) parts.push([mc.p, 0.35]);
  if (btUse.p != null && btUse.n >= 10) parts.push([btUse.p, 0.45]);
  if (jm.p != null) parts.push([jm.p, 0.2]);
  const wsum = parts.reduce((a, x) => a + x[1], 0);
  const pw = wsum ? parts.reduce((a, x) => a + x[0] * x[1], 0) / wsum : 1 / (1 + rr);
  const spread = parts.length > 1 ? Math.max(...parts.map(x => x[0])) - Math.min(...parts.map(x => x[0])) : 1;
  const evR = pw * rr - (1 - pw), evUsd = pw * rewardUsd - (1 - pw) * riskUsd;
  const verdict = evR > 0.15 ? ['good', 'Favorable'] : evR > -0.1 ? ['mid', 'Marginal'] : ['bad', 'Unfavorable'];

  const notes = [];
  const note = (cls, text) => notes.push({ cls, text });
  const riskPct = riskUsd / settings.balance * 100;
  if (slAtr < 0.5) note('bad', `Stop is only ${slAtr.toFixed(2)} ATR away — inside normal noise. Gold wicks ${fmt(A)} per ${ui.tf} bar on average; expect to get stopped out often.`);
  else if (slAtr > 4) note('warn', `Stop is ${slAtr.toFixed(1)} ATR away — wide. Fine for swing trades, but size down.`);
  if (rr < 1) note('warn', `Reward:risk is ${rr.toFixed(2)} — you need a ${pct(1 / (1 + rr))} win rate just to break even.`);
  if (riskPct > 2) note('bad', `This risks ${riskPct.toFixed(1)}% of your ${usd(settings.balance)} account. Most traders cap risk at 1–2%.`);
  else note('good', `Risk ${usd(riskUsd)} = ${riskPct.toFixed(2)}% of account.`);
  if ((p.dir === 'long' && m.bias === 'Bearish') || (p.dir === 'short' && m.bias === 'Bullish')) note('warn', `Counter-trend: ${ui.tf.toUpperCase()} bias is ${m.bias}. Counter-trend trades need tighter management.`);
  else if (m.bias !== 'Neutral') note('good', `Aligned with ${ui.tf.toUpperCase()} ${m.bias.toLowerCase()} bias.`);
  const htf = Object.entries(mtf).filter(([tf, v]) => tf !== ui.tf && v.score != null && Math.abs(v.score) >= 2 && Math.sign(v.score) !== s).map(([tf]) => tf.toUpperCase());
  if (htf.length) note('warn', `Against the trend on ${htf.join(', ')}.`);
  if (p.dir === 'long' && m.rsi > 70) note('warn', 'Buying with RSI > 70 — chasing an overbought move.');
  if (p.dir === 'short' && m.rsi < 30) note('warn', 'Selling with RSI < 30 — chasing an oversold move.');
  const obstacle = (s > 0 ? m.sr.res : m.sr.sup).find(l => s * (l.price - p.entry) > 0.2 * A && s * (p.tp - l.price) > 0.2 * A);
  if (obstacle) note('warn', `${s > 0 ? 'Resistance' : 'Support'} at ${fmt(obstacle.price)} (${obstacle.touches} touches) sits between entry and target — price may stall there.`);
  const dist = Math.abs(p.entry - m.price) / A;
  if (dist > 1) note('warn', `Entry is ${dist.toFixed(1)} ATR from market (pending order). Odds assume you get filled.`);
  if (m.session === 'Asia' && ui.tf !== '1d' && ui.tf !== '4h') note('warn', 'Asian session: gold is usually quieter until London opens (07:00 UTC) — targets take longer.');
  if (mc.open / mc.n > 0.3) note('warn', `${pct(mc.open / mc.n)} of simulations hit neither level within 300 bars — target may be ambitious for this timeframe.`);

  return { s, risk, reward, rr, riskUsd, rewardUsd, slAtr, tpAtr, mc, bt, btUse, jm, pw, spread, evR, evUsd, verdict, notes, eta: mc.medBars ? mc.medBars * TF[ui.tf].sec : null };
}

let planTimer = null, lastPlanRun = 0;
function schedulePlan(ms = 300) { clearTimeout(planTimer); planTimer = setTimeout(runPlan, ms); }
function runPlan() {
  if (!calc || !calc.market) return;
  lastPlanRun = Date.now();
  if (plan.market) { plan.entry = r2(lastPrice ?? calc.market.price); $('#pEntry').value = plan.entry; }
  store.set('plan', plan);
  const out = $('#planOut');
  const r = evaluate(plan);
  if (r.errs) { out.innerHTML = r.errs.map(e => `<div class="note bad">${esc(e)}</div>`).join(''); renderPlanLines(false); return; }
  renderPlanLines(true);
  const breakeven = 1 / (1 + r.rr);
  out.innerHTML = `
    <div class="verdict ${r.verdict[0]}">
      <div class="head"><b>${r.verdict[1]}</b><span>EV ${r.evR >= 0 ? '+' : ''}${r.evR.toFixed(2)}R · ${usd(r.evUsd)}</span></div>
      <div class="prob-bar"><div class="w" style="width:${r.pw * 100}%">TP ${pct(r.pw)}</div><div class="l" style="width:${(1 - r.pw) * 100}%">SL ${pct(1 - r.pw)}</div></div>
      <div class="muted" style="font-size:11.5px">Estimated chance of hitting TP before SL. Break-even win rate at ${r.rr.toFixed(2)}R is ${pct(breakeven)}.
      ${r.eta ? ` Typical time to outcome: ~${durText(r.eta)}.` : ''} Model agreement: ${r.spread < 0.08 ? 'high' : r.spread < 0.16 ? 'moderate' : 'low'}.</div>
    </div>
    <div class="stats three">
      <div class="stat"><span>R:R</span><b>${r.rr.toFixed(2)}</b></div>
      <div class="stat"><span>Risk</span><b class="down">${usd(r.riskUsd)}</b></div>
      <div class="stat"><span>Reward</span><b class="up">${usd(r.rewardUsd)}</b></div>
      <div class="stat"><span>Stop</span><b>${fmt(r.risk)}</b> <small>${r.slAtr.toFixed(2)} ATR</small></div>
      <div class="stat"><span>Target</span><b>${fmt(r.reward)}</b> <small>${r.tpAtr.toFixed(2)} ATR</small></div>
      <div class="stat"><span>Lots</span><b>${plan.lots}</b> <small>${fmt(plan.lots * OZ, 0)} oz</small></div>
    </div>
    <h4>How the estimate is built</h4>
    <table class="models">
      <tr><td>Monte Carlo (${r.mc.n.toLocaleString()} paths)</td><td class="r">${pct(r.mc.p)}</td><td class="r muted">35%</td></tr>
      <tr><td>${r.btUse.label} (n=${r.btUse.n})</td><td class="r">${r.btUse.n >= 10 ? pct(r.btUse.p) : 'too few'}</td><td class="r muted">45%</td></tr>
      <tr><td>Your ${plan.dir} trades (n=${r.jm.n})</td><td class="r">${r.jm.p != null ? pct(r.jm.p) : 'need 5+'}</td><td class="r muted">20%</td></tr>
    </table>
    <p class="hint" style="margin-top:6px">Monte Carlo replays the last ${Math.min(candles.length - 1, 600)} ${ui.tf} bars with trend removed. History tests this exact stop/target (in ATR units) at every past bar${r.btUse.label.includes('regime') ? ' that had the same bias as now' : ''}. Weights renormalise when a model lacks data.</p>
    <h4>Checklist</h4>
    ${r.notes.map(n => `<div class="note ${n.cls}">${esc(n.text)}</div>`).join('')}`;
}

function syncPlanInputs() {
  $('#pEntry').value = plan.entry ?? ''; $('#pSL').value = plan.sl ?? ''; $('#pTP').value = plan.tp ?? ''; $('#pLots').value = plan.lots ?? '';
  $('#pMarket').checked = !!plan.market;
  $$('#planDir button').forEach(b => b.classList.toggle('on', b.dataset.dir === plan.dir));
}
// ATR template / Smart levels act as toggles: a second click restores what was there before.
// Editing any level by hand (or flipping direction) keeps your edits and ends the toggle.
let planTemplate = null; // { kind: 'atr' | 'smart', before: { entry, sl, tp, market } }
function markTemplate() {
  $('#atrBtn').classList.toggle('on', planTemplate?.kind === 'atr');
  $('#suggestBtn').classList.toggle('on', planTemplate?.kind === 'smart');
  $('#myStyleBtn').classList.toggle('on', planTemplate?.kind === 'mine');
}
function clearTemplate() { if (planTemplate) { planTemplate = null; markTemplate(); } }
function toggleTemplate(kind, levels, label) {
  if (planTemplate?.kind === kind) {
    Object.assign(plan, planTemplate.before);
    planTemplate = null; markTemplate(); syncPlanInputs(); runPlan();
    toast(`${label} removed.`);
    return false;
  }
  const before = planTemplate ? planTemplate.before : { entry: plan.entry, sl: plan.sl, tp: plan.tp, market: plan.market, lots: plan.lots };
  Object.assign(plan, levels);
  planTemplate = { kind, before }; markTemplate(); syncPlanInputs(); runPlan();
  return true;
}
function bindPlan() {
  $$('#planDir button').forEach(b => b.onclick = () => {
    if (plan.dir === b.dataset.dir) return;
    plan.dir = b.dataset.dir;
    clearTemplate();
    if (ok(plan.entry) && ok(plan.sl) && ok(plan.tp)) { // mirror levels around entry
      plan.sl = r2(2 * plan.entry - plan.sl); plan.tp = r2(2 * plan.entry - plan.tp);
    }
    syncPlanInputs(); runPlan();
  });
  [['#pEntry', 'entry'], ['#pSL', 'sl'], ['#pTP', 'tp'], ['#pLots', 'lots']].forEach(([sel, k]) => $(sel).addEventListener('input', e => {
    plan[k] = num(e.target.value);
    if (k !== 'lots') clearTemplate();
    if (k === 'entry') { plan.market = false; $('#pMarket').checked = false; }
    schedulePlan();
  }));
  $('#pMarket').onchange = e => { plan.market = e.target.checked; runPlan(); };
  $$('[data-pick]').forEach(b => b.onclick = () => setTool('pick-' + b.dataset.pick, `Click the chart to set ${b.dataset.pick.toUpperCase()} (Esc to cancel)`));
  $('#atrBtn').onclick = () => {
    if (!calc) return;
    const A = calc.market.atr, s = plan.dir === 'long' ? 1 : -1, e = ok(plan.entry) ? plan.entry : lastPrice;
    toggleTemplate('atr', { entry: r2(e), sl: r2(e - s * 1.5 * A), tp: r2(e + s * 3 * A) }, 'ATR template');
  };
  $('#suggestBtn').onclick = () => {
    if (!calc) return;
    const applied = toggleTemplate('smart', smartLevels(plan.dir, ok(plan.entry) ? plan.entry : lastPrice), 'Smart levels');
    if (applied) toast('Stop placed beyond the nearest swing level, target at the next level (or 2R). Click again to remove.');
  };
  $('#myStyleBtn').onclick = () => {
    if (!calc) return;
    const st = learnStyle();
    if (!st || !ok(st.stop)) return toast('No closed trades with a stop loss yet. Log or sync some trades first.');
    const s = plan.dir === 'long' ? 1 : -1, e = ok(plan.entry) ? plan.entry : lastPrice;
    const applied = toggleTemplate('mine', { entry: r2(e), sl: r2(e - s * st.stop), tp: r2(e + s * 1.5 * st.stop), lots: st.lots }, 'My style');
    if (applied) toast(`Your typical ${usd(st.stop)} stop and ${st.lots} lots (from ${st.n} trade${st.n > 1 ? 's' : ''}); target set at 1.5R. Click again to remove.`);
  };
  $('#clearPlanBtn').onclick = () => {
    if (!ok(plan.sl) && !ok(plan.tp)) return toast('No levels to clear.');
    plan.sl = null; plan.tp = null;
    clearTemplate(); syncPlanInputs(); runPlan();
    toast('Stop loss and take profit cleared from the planner and the chart.');
  };
  $('#sizeBtn').onclick = () => {
    if (!ok(plan.entry) || !ok(plan.sl) || plan.entry === plan.sl) return toast('Set entry and stop first.');
    const lots = Math.floor(settings.balance * settings.risk / 100 / (Math.abs(plan.entry - plan.sl) * OZ) * 100) / 100;
    plan.lots = Math.max(0.01, lots); syncPlanInputs(); runPlan();
    toast(`${plan.lots} lots risks ≈${settings.risk}% of ${usd(settings.balance)}.`);
  };
  $('#logBtn').onclick = () => {
    if (!calc) return toast('Waiting for market data…');
    const r = evaluate(plan);
    if (r.errs) return toast(r.errs[0]);
    addTrade({ dir: plan.dir, entry: plan.entry, sl: plan.sl, tp: plan.tp, lots: plan.lots, openTime: Date.now(), status: 'open', est: r2(r.pw) });
    toast('Trade logged in your journal as open.');
  };
}

// ---------- journal ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
function finalize(t) {
  const s = t.dir === 'long' ? 1 : -1;
  if (t.status === 'closed' && ok(t.exit)) t.pnl = r2(s * (t.exit - t.entry) * t.lots * OZ);
  t.r = t.status === 'closed' && ok(t.sl) && t.sl !== t.entry && ok(t.exit) ? Math.round(s * (t.exit - t.entry) / Math.abs(t.entry - t.sl) * 100) / 100 : null;
  return t;
}
function addTrade(t) {
  trades.push(finalize({ id: uid(), tag: '', notes: '', ...t }));
  saveTrades(); renderJournal();
}
function closeTrade(id, price, reason) {
  const t = trades.find(x => x.id === id);
  if (!t || t.status !== 'open') return;
  Object.assign(t, { status: 'closed', exit: r2(price), closeTime: Date.now(), reason });
  finalize(t); saveTrades(); renderJournal();
  toast(`${t.dir === 'long' ? 'Long' : 'Short'} closed${reason ? ' (' + reason + ')' : ''}: ${usd(t.pnl)}${t.r != null ? ` · ${t.r}R` : ''}`, 5000);
}
function checkAutoClose(px) {
  if (!settings.autoClose) return;
  for (const t of trades) {
    if (t.status !== 'open') continue;
    const long = t.dir === 'long';
    if (ok(t.sl) && (long ? px <= t.sl : px >= t.sl)) closeTrade(t.id, t.sl, 'stop loss hit');
    else if (ok(t.tp) && (long ? px >= t.tp : px <= t.tp)) closeTrade(t.id, t.tp, 'take profit hit');
  }
}
function liveAdvice(t, px) {
  const s = t.dir === 'long' ? 1 : -1, out = [];
  const pnl = s * (px - t.entry) * t.lots * OZ;
  let p = null;
  if (ok(t.sl) && ok(t.tp)) {
    const dSL = Math.max(0, s * (px - t.sl)), dTP = Math.max(0, s * (t.tp - px));
    p = dSL + dTP > 0 ? dSL / (dSL + dTP) : null; // driftless barrier-hit probability
    const prog = s * (px - t.entry) / Math.abs(t.tp - t.entry);
    if (prog >= 0.5 && s * (t.entry - t.sl) > 0) out.push(['good', `${pct(prog)} of the way to target — consider moving the stop to breakeven (${fmt(t.entry)}).`]);
    if (p != null && p < 0.3) out.push(['bad', 'Price is close to your stop. Let the stop do its job — don\'t widen it.']);
  } else if (!ok(t.sl)) out.push(['bad', 'No stop loss set on this trade.']);
  const m = calc && calc.market;
  if (m && ((s > 0 && m.bias === 'Bearish') || (s < 0 && m.bias === 'Bullish'))) out.push(['warn', `${ui.tf.toUpperCase()} bias has turned ${m.bias.toLowerCase()} against this position.`]);
  return { pnl, p, out };
}
function renderOpenTrades() {
  const open = trades.filter(t => t.status === 'open');
  const px = lastPrice;
  $('#openTrades').innerHTML = `<h4>Open positions (${open.length})</h4>` + (open.length ? open.map(t => {
    const a = px != null ? liveAdvice(t, px) : { pnl: null, p: null, out: [] };
    return `<div class="trade ${t.dir}">
      <div class="row"><b>${t.dir === 'long' ? 'LONG' : 'SHORT'} ${t.lots} @ ${fmt(t.entry)}</b><span class="pnl ${sgn(a.pnl)}">${usd(a.pnl)}</span></div>
      <div class="row meta"><span>SL ${fmt(t.sl)} · TP ${fmt(t.tp)}</span><span>${a.p != null ? `P(TP) now <b class="${a.p >= 0.5 ? 'up' : 'down'}">${pct(a.p)}</b>` : ''}</span></div>
      ${t.est != null ? `<div class="meta">Estimated at entry: ${pct(t.est)} · opened ${new Date(t.openTime).toLocaleString()}</div>` : ''}
      ${a.out.map(([c, x]) => `<div class="note ${c}" style="margin-top:6px">${esc(x)}</div>`).join('')}
      <div class="actions"><button class="ghost" data-close="${t.id}">Close @ market</button><button class="ghost" data-closeat="${t.id}">Close @ price…</button><button class="ghost danger" data-del="${t.id}">Delete</button></div>
    </div>`;
  }).join('') : '<div class="empty">No open trades. Log one from the Trade Planner or add it below.</div>');
  renderPlanLines(ui.tab === 'plan' && !planInvalid());
}
const planInvalid = () => !(ok(plan.entry) && ok(plan.sl) && ok(plan.tp)) || (plan.dir === 'long' ? !(plan.sl < plan.entry && plan.tp > plan.entry) : !(plan.sl > plan.entry && plan.tp < plan.entry));
function renderJournal() {
  renderOpenTrades();
  const closed = trades.filter(t => t.status === 'closed').sort((a, b) => (b.closeTime || b.openTime) - (a.closeTime || a.openTime));
  $('#closedTrades').innerHTML = `<h4>Closed trades (${closed.length})</h4>` + (closed.length ? `<table>
    <tr><th>Date</th><th>Side</th><th class="r">Entry → Exit</th><th class="r">R</th><th class="r">P&amp;L</th><th></th></tr>
    ${closed.slice(0, 300).map(t => `<tr title="${esc([t.tag, t.notes, t.reason].filter(Boolean).join(' · '))}">
      <td>${new Date(t.openTime).toLocaleDateString([], { month: 'short', day: 'numeric' })}</td>
      <td class="${t.dir === 'long' ? 'up' : 'down'}">${t.dir === 'long' ? 'L' : 'S'} ${t.lots}</td>
      <td class="r">${fmt(t.entry)} → ${fmt(t.exit)}</td>
      <td class="r ${sgn(t.r)}">${t.r ?? '—'}</td>
      <td class="r ${sgn(t.pnl)}">${usd(t.pnl)}</td>
      <td><button class="del" data-del="${t.id}" title="Delete">✕</button></td></tr>`).join('')}</table>` : '<div class="empty">No closed trades yet.</div>');
  renderMarkers();
  if (ui.tab === 'analytics') renderAnalytics();
}
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.close) { if (lastPrice != null) closeTrade(b.dataset.close, lastPrice, 'manual'); }
  else if (b.dataset.closeat) {
    const v = num(prompt('Exit price:', lastPrice != null ? r2(lastPrice) : ''));
    if (v != null) closeTrade(b.dataset.closeat, v, 'manual');
  } else if (b.dataset.del) {
    if (confirm('Delete this trade?')) {
      if (b.dataset.del.startsWith('mt5-')) store.set('syncDeleted', [...new Set([...store.get('syncDeleted', []), b.dataset.del])]);
      trades = trades.filter(t => t.id !== b.dataset.del); saveTrades(); renderJournal();
    }
  }
});

$('#addForm').addEventListener('submit', e => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  const exit = num(f.exit);
  const t = {
    dir: f.dir, entry: num(f.entry), sl: num(f.sl), tp: num(f.tp), lots: num(f.lots),
    openTime: new Date(f.openTime).getTime(), tag: f.tag.trim(), notes: f.notes.trim(),
    status: exit != null ? 'closed' : 'open', exit,
    closeTime: exit != null ? (f.closeTime ? new Date(f.closeTime).getTime() : Date.now()) : null,
  };
  if (!ok(t.entry) || !(t.lots > 0) || !ok(t.openTime)) return toast('Entry, lots and open time are required.');
  addTrade(t); e.target.reset(); setDefaultOpenTime();
  toast('Trade saved.');
});
function setDefaultOpenTime() {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  $('#addForm [name=openTime]').value = d.toISOString().slice(0, 16);
}

// CSV import/export
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : (text.includes('\t') ? '\t' : ',');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim()));
}
const parseDate = s => {
  if (!s) return null;
  s = s.trim().replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3');
  let t = Date.parse(s);
  if (!isFinite(t)) t = Date.parse(s.replace(' ', 'T'));
  return isFinite(t) ? t : null;
};
function importCSV(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) return toast('CSV looks empty.');
  const head = rows[0].map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (...names) => head.findIndex(h => names.includes(h));
  const priceCols = head.map((h, i) => h === 'price' ? i : -1).filter(i => i >= 0);
  const timeCols = head.map((h, i) => h === 'time' ? i : -1).filter(i => i >= 0); // MT5: Time … Time
  const col = {
    open: find('opentime', 'date', 'time', 'opendate', 'entrytime', 'datetime'),
    close: find('closetime', 'closedate', 'exittime') >= 0 ? find('closetime', 'closedate', 'exittime') : timeCols[1] ?? -1,
    dir: find('type', 'side', 'direction', 'action'),
    entry: find('entry', 'openprice', 'entryprice') >= 0 ? find('entry', 'openprice', 'entryprice') : priceCols[0] ?? -1,
    exit: find('exit', 'closeprice', 'exitprice') >= 0 ? find('exit', 'closeprice', 'exitprice') : priceCols[1] ?? -1,
    sl: find('sl', 'stoploss', 'stop'), tp: find('tp', 'takeprofit', 'target'),
    lots: find('lots', 'volume', 'size', 'lot', 'qty', 'quantity'),
    pnl: find('profit', 'pnl', 'pl', 'netprofit'), sym: find('symbol', 'item', 'instrument'),
    tag: find('tag', 'setup', 'strategy'), notes: find('notes', 'comment', 'note'),
  };
  if (col.entry < 0 || col.dir < 0) return toast('Need at least a side/type column and an entry/price column.', 6000);
  const body = rows.slice(1);
  const goldOnly = col.sym >= 0 && body.some(r => /xau|gold/i.test(r[col.sym] || ''));
  let added = 0, skipped = 0;
  for (const r of body) {
    const g = k => col[k] >= 0 ? (r[col[k]] || '').trim() : '';
    if (goldOnly && !/xau|gold/i.test(g('sym'))) { skipped++; continue; }
    const d = g('dir').toLowerCase();
    const dir = /buy|long|^b$/.test(d) ? 'long' : /sell|short|^s$/.test(d) ? 'short' : null;
    const entry = num(g('entry').replace(/,/g, ''));
    if (!dir || entry == null) { skipped++; continue; }
    let exit = num(g('exit').replace(/,/g, ''));
    const lots = num(g('lots')) || 0.01;
    const pnl = num(g('pnl').replace(/,/g, ''));
    if (exit == null && pnl != null) exit = entry + (dir === 'long' ? 1 : -1) * pnl / (lots * OZ);
    const t = {
      dir, entry, lots, sl: num(g('sl')) || null, tp: num(g('tp')) || null,
      openTime: parseDate(g('open')) || Date.now(), closeTime: parseDate(g('close')),
      tag: g('tag'), notes: g('notes'), status: exit != null ? 'closed' : 'open', exit,
    };
    if (t.status === 'closed' && !t.closeTime) t.closeTime = t.openTime;
    finalize(t);
    if (pnl != null && t.status === 'closed') t.pnl = pnl; // trust broker P&L (includes contract size/commission)
    trades.push({ id: uid(), ...t });
    added++;
  }
  saveTrades(); renderJournal();
  toast(`Imported ${added} trades${skipped ? `, skipped ${skipped}` : ''}.`, 5000);
}
function exportCSV() {
  const cols = ['openTime', 'closeTime', 'dir', 'entry', 'sl', 'tp', 'exit', 'lots', 'pnl', 'r', 'status', 'tag', 'notes'];
  const cell = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : (v ?? '');
  const lines = [cols.join(',')].concat(trades.map(t => cols.map(c => c.endsWith('Time') ? (t[c] ? new Date(t[c]).toISOString() : '') : cell(t[c])).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `goldterm-journal-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- analytics ----------
function groupStats(list, keyFn) {
  const g = {};
  for (const t of list) { const k = keyFn(t); (g[k] = g[k] || []).push(t); }
  return Object.entries(g).map(([k, ts]) => {
    const rs = ts.filter(t => t.r != null);
    return { k, n: ts.length, win: ts.filter(t => t.pnl > 0).length / ts.length, net: ts.reduce((a, t) => a + t.pnl, 0), avgR: rs.length ? rs.reduce((a, t) => a + t.r, 0) / rs.length : null };
  });
}
// Your trading style, learned from your closed trades (journal + MetaTrader sync).
const median = a => { const s = a.filter(ok).sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
function learnStyle(c = trades.filter(t => t.status === 'closed' && ok(t.pnl))) {
  if (!c.length) return null;
  const withSL = c.filter(t => ok(t.sl)), withTP = c.filter(t => ok(t.tp));
  const manual = c.filter(t => !t.reason || /manual/.test(t.reason));
  const holds = c.filter(t => t.closeTime > t.openTime).map(t => (t.closeTime - t.openTime) / 1000);
  const roundSL = withSL.filter(t => Math.abs(t.sl / 5 - Math.round(t.sl / 5)) < 0.01);
  const sess = {}; c.forEach(t => { const s = sessionOf(t.openTime); sess[s] = (sess[s] || 0) + 1; });
  return {
    n: c.length, lots: median(c.map(t => t.lots)), stop: median(withSL.map(t => Math.abs(t.entry - t.sl))),
    slShare: withSL.length / c.length, tpShare: withTP.length / c.length, manualShare: manual.length / c.length,
    hold: median(holds), exitR: median(c.map(t => t.r)), roundShare: withSL.length ? roundSL.length / withSL.length : null,
    longShare: c.filter(t => t.dir === 'long').length / c.length, topSession: Object.entries(sess).sort((a, b) => b[1] - a[1])[0][0],
  };
}
function styleHTML(st) {
  if (!st) return '';
  const notes = [];
  const early = st.n < 20;
  if (st.slShare >= 0.9) notes.push(['good', 'You always set a stop loss. Keep that habit; it is what protects a prop account.']);
  else notes.push(['bad', `${pct(1 - st.slShare)} of your trades had no stop loss.`]);
  if (st.tpShare < 0.3) notes.push(['warn', `You set a take-profit on only ${pct(st.tpShare)} of trades and close ${pct(st.manualShare)} by hand. Your typical exit is ${st.exitR != null ? (st.exitR >= 0 ? '+' : '') + st.exitR.toFixed(2) + 'R' : 'n/a'}. Planning a target before entry (the planner suggests 1.5R) gives you a rule to hold winners to.`]);
  if (st.hold != null && st.hold < 3600 && ok(st.stop)) notes.push(['warn', `Median hold ${durText(st.hold)} with a ${usd(st.stop)} stop: a $0.30 spread is about ${pct(0.3 / st.stop)} of your risk on every trade. Short holds need tight costs.`]);
  if (st.roundShare != null && st.roundShare >= 0.5) notes.push(['warn', `${pct(st.roundShare)} of your stops sit exactly on round numbers (like 4,190.00). Many traders put stops there, so price often wicks to them; placing yours $1–2 beyond is a common adjustment.`]);
  if (ok(st.stop) && ok(st.lots)) notes.push(['', `Typical risk per trade: ${usd(st.stop * st.lots * OZ)} (${st.lots} lots × ${usd(st.stop)} stop), ${(st.stop * st.lots * OZ / settings.balance * 100).toFixed(2)}% of your ${usd(settings.balance)} balance setting. Check it against your prop firm's daily-loss limit.`]);
  return `<h4>Your trading style ${early ? `<span class="muted">· early read, ${st.n} trade${st.n > 1 ? 's' : ''} (reliable from ~20)</span>` : ''}</h4>
    <div class="stats three">
      <div class="stat"><span>Typical size</span><b>${st.lots ?? '—'}</b> <small>lots</small></div>
      <div class="stat"><span>Typical stop</span><b>${ok(st.stop) ? usd(st.stop) : '—'}</b></div>
      <div class="stat"><span>Typical hold</span><b style="font-size:13px">${st.hold != null ? durText(st.hold) : '—'}</b></div>
      <div class="stat"><span>Uses a TP</span><b>${pct(st.tpShare)}</b></div>
      <div class="stat"><span>Closed by hand</span><b>${pct(st.manualShare)}</b></div>
      <div class="stat"><span>Long / short</span><b style="font-size:13px">${pct(st.longShare)} / ${pct(1 - st.longShare)}</b></div>
    </div>
    ${notes.map(([cls, t]) => `<div class="note ${cls}">${esc(t)}</div>`).join('')}
    <p class="hint">Most trades in: ${esc(st.topSession)} session. The planner's "My style" button uses your typical stop and size.</p>`;
}
function renderAnalytics() {
  const el = $('#tab-analytics');
  const c = trades.filter(t => t.status === 'closed' && ok(t.pnl)).sort((a, b) => (a.closeTime || a.openTime) - (b.closeTime || b.openTime));
  if (!c.length) { el.innerHTML = '<div class="empty">Close or import some trades to see your performance analysis.</div>'; return; }
  const wins = c.filter(t => t.pnl > 0), losses = c.filter(t => t.pnl <= 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -losses.reduce((a, t) => a + t.pnl, 0);
  const net = gp - gl, wr = wins.length / c.length;
  const avgW = wins.length ? gp / wins.length : 0, avgL = losses.length ? gl / losses.length : 0;
  const rs = c.filter(t => t.r != null), avgR = rs.length ? rs.reduce((a, t) => a + t.r, 0) / rs.length : null;
  let eq = settings.balance, peak = eq, mdd = 0, streak = 0, maxStreak = 0;
  const curve = [eq];
  for (const t of c) {
    eq += t.pnl; curve.push(eq); peak = Math.max(peak, eq); mdd = Math.max(mdd, (peak - eq) / peak);
    streak = t.pnl <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak);
  }
  const held = c.filter(t => t.closeTime > t.openTime).map(t => (t.closeTime - t.openTime) / 1000);
  const avgHeld = held.length ? held.reduce((a, v) => a + v, 0) / held.length : null;

  const table = (title, rows) => rows.length ? `<h4>${title}</h4><table><tr><th></th><th class="r">Trades</th><th class="r">Win%</th><th class="r">Avg R</th><th class="r">Net</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.k)}</td><td class="r">${r.n}</td><td class="r">${pct(r.win)}</td><td class="r ${sgn(r.avgR)}">${r.avgR != null ? r.avgR.toFixed(2) : '—'}</td><td class="r ${sgn(r.net)}">${usd(r.net)}</td></tr>`).join('')}</table>` : '';
  const byDir = groupStats(c, t => t.dir === 'long' ? 'Long' : 'Short');
  const bySess = groupStats(c, t => sessionOf(t.openTime));
  const byDay = groupStats(c, t => WEEKDAYS[new Date(t.openTime).getDay()]).sort((a, b) => WEEKDAYS.indexOf(a.k) - WEEKDAYS.indexOf(b.k));
  const byTag = groupStats(c.filter(t => t.tag), t => t.tag.toLowerCase());

  el.innerHTML = `${styleHTML(learnStyle(c))}
    <h4>Performance</h4>
    <div class="stats three">
      <div class="stat"><span>Net P&amp;L</span><b class="${sgn(net)}">${usd(net)}</b></div>
      <div class="stat"><span>Win rate</span><b>${pct(wr)}</b> <small>${wins.length}/${c.length}</small></div>
      <div class="stat"><span>Profit factor</span><b>${gl ? (gp / gl).toFixed(2) : '∞'}</b></div>
      <div class="stat"><span>Expectancy</span><b class="${sgn(net)}">${usd(net / c.length)}</b> <small>/trade</small></div>
      <div class="stat"><span>Avg R</span><b class="${sgn(avgR)}">${avgR != null ? avgR.toFixed(2) : '—'}</b></div>
      <div class="stat"><span>Max DD</span><b class="down">${pct(mdd, 1)}</b></div>
      <div class="stat"><span>Avg win</span><b class="up">${usd(avgW)}</b></div>
      <div class="stat"><span>Avg loss</span><b class="down">${usd(-avgL)}</b></div>
      <div class="stat"><span>Loss streak</span><b>${maxStreak}</b> <small>max</small></div>
    </div>
    <h4>Equity curve</h4><div class="card equity">${equitySVG(curve)}</div>
    ${rs.length ? `<h4>R-multiple distribution</h4><div class="card hist">${histSVG(rs.map(t => t.r))}</div>` : ''}
    <h4>Coach's insights</h4>
    ${insights(c, { wr, avgW, avgL, avgR, byDir, bySess, byDay, byTag, avgHeld }).map(([cls, txt]) => `<div class="note ${cls}">${esc(txt)}</div>`).join('')}
    ${table('By direction', byDir)}${table('By session (UTC)', bySess)}${table('By weekday', byDay)}${table('By setup', byTag)}`;
}
function equitySVG(curve) {
  const W = 340, H = 110, min = Math.min(...curve), max = Math.max(...curve), span = max - min || 1;
  const pts = curve.map((v, i) => `${(i / Math.max(1, curve.length - 1) * W).toFixed(1)},${(H - 6 - (v - min) / span * (H - 12)).toFixed(1)}`);
  const up = curve[curve.length - 1] >= curve[0];
  const col = up ? COL.up : COL.down;
  const base = H - 6 - (curve[0] - min) / span * (H - 12);
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">
    <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="${COL.muted}" stroke-dasharray="3 3" stroke-width="1" opacity=".5"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
    <div class="row meta" style="display:flex;justify-content:space-between"><span>${usd(curve[0])}</span><span>${usd(curve[curve.length - 1])}</span></div>`;
}
function histSVG(rs) {
  const edges = [-3, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 3, 5];
  const labels = ['<-3', '-3', '-2', '-1.5', '-1', '-0.5', '0', '0.5', '1', '1.5', '2', '3', '5+'];
  const bins = new Array(edges.length + 1).fill(0);
  rs.forEach(r => { let i = edges.findIndex(e => r < e); if (i < 0) i = edges.length; bins[i]++; });
  const W = 340, H = 90, bw = W / bins.length, mx = Math.max(...bins);
  return `<svg viewBox="0 0 ${W} ${H + 14}" style="height:${H + 14}px">${bins.map((b, i) => {
    const h = b / mx * (H - 4), neg = i <= edges.indexOf(0);
    return `<rect x="${i * bw + 2}" y="${H - h}" width="${bw - 4}" height="${h}" rx="2" fill="${neg ? COL.down : COL.up}" opacity=".85"><title>${labels[i]}R…: ${b}</title></rect>
      <text x="${i * bw + bw / 2}" y="${H + 11}" text-anchor="middle" font-size="8" fill="${COL.muted}">${labels[i]}</text>`;
  }).join('')}</svg>`;
}
function insights(c, s) {
  const out = [];
  if (c.length < 10) out.push(['warn', `Only ${c.length} closed trades — patterns below are tentative until you have 20–30+.`]);
  const be = s.avgW + s.avgL ? s.avgL / (s.avgW + s.avgL) : null;
  if (be != null) out.push([s.wr >= be ? 'good' : 'bad', `With your average win ${usd(s.avgW)} and average loss ${usd(-s.avgL)}, you need a ${pct(be)} win rate to break even. You're at ${pct(s.wr)}.`]);
  if (s.avgL > s.avgW * 1.3 && s.wr < 0.65) out.push(['bad', `Your losers are ${(s.avgL / s.avgW).toFixed(1)}× bigger than your winners. Cut losses at your planned stop and let winners reach target.`]);
  const blowouts = c.filter(t => t.r != null && t.r < -1.2);
  if (blowouts.length) out.push(['bad', `${blowouts.length} trade(s) lost more than 1.2R — the stop was moved, ignored or slipped. Worst: ${Math.min(...blowouts.map(t => t.r))}R.`]);
  const noSL = c.filter(t => !ok(t.sl));
  if (noSL.length) out.push(['warn', `${noSL.length} of ${c.length} trades had no recorded stop loss, so R can't be measured for them.`]);
  const early = c.filter(t => t.pnl > 0 && ok(t.tp) && Math.abs(t.exit - t.entry) < 0.6 * Math.abs(t.tp - t.entry));
  const winsTP = c.filter(t => t.pnl > 0 && ok(t.tp)).length;
  if (winsTP >= 3 && early.length / winsTP > 0.4) out.push(['warn', `${pct(early.length / winsTP)} of your winners were closed before 60% of the way to target. Taking profit early caps your R:R.`]);
  const L = s.byDir.find(x => x.k === 'Long'), S = s.byDir.find(x => x.k === 'Short');
  if (L && S && L.n >= 3 && S.n >= 3 && Math.abs(L.win - S.win) > 0.2) {
    const [b, w] = L.win > S.win ? [L, S] : [S, L];
    out.push(['warn', `You trade ${b.k.toLowerCase()}s much better (${pct(b.win)} win, ${usd(b.net)}) than ${w.k.toLowerCase()}s (${pct(w.win)}, ${usd(w.net)}). Consider filtering ${w.k.toLowerCase()} setups harder.`]);
  }
  const rank = (arr, label) => {
    const q = arr.filter(x => x.n >= 3);
    if (q.length < 2) return;
    q.sort((a, b) => b.net / b.n - a.net / a.n);
    const best = q[0], worst = q[q.length - 1];
    if (best.net > 0) out.push(['good', `Best ${label}: ${best.k} (${pct(best.win)} win rate, ${usd(best.net)} over ${best.n} trades).`]);
    if (worst.net < 0) out.push(['bad', `Worst ${label}: ${worst.k} (${pct(worst.win)} win rate, ${usd(worst.net)}). Trade smaller there or skip it.`]);
  };
  rank(s.bySess, 'session'); rank(s.byDay, 'day'); rank(s.byTag, 'setup');
  // tilt: performance right after a loss
  let afterLoss = 0, afterLossW = 0, upsize = 0;
  for (let i = 1; i < c.length; i++) if (c[i - 1].pnl <= 0) {
    afterLoss++; if (c[i].pnl > 0) afterLossW++;
    if (c[i].lots > c[i - 1].lots * 1.2) upsize++;
  }
  if (afterLoss >= 5 && afterLossW / afterLoss < s.wr - 0.15) out.push(['bad', `After a loss your next trade wins only ${pct(afterLossW / afterLoss)} vs ${pct(s.wr)} overall — a sign of revenge trading. Take a break after a stop-out.`]);
  if (upsize >= 2) out.push(['bad', `You increased position size right after a loss ${upsize} times. Keep risk per trade constant.`]);
  const est = c.filter(t => t.est != null);
  if (est.length >= 10) {
    const exp = est.reduce((a, t) => a + t.est, 0) / est.length, act = est.filter(t => t.pnl > 0).length / est.length;
    out.push([Math.abs(exp - act) < 0.1 ? 'good' : 'warn', `On ${est.length} planner-logged trades the model expected a ${pct(exp)} hit rate; you achieved ${pct(act)}.`]);
  }
  if (s.avgHeld) out.push(['', `Average holding time: ${durText(s.avgHeld)}.`]);
  return out;
}

// ---------- tabs, toolbar, settings ----------
function setTab(tab) {
  ui.tab = tab; saveUI();
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $$('.tab-body').forEach(b => b.classList.toggle('on', b.id === 'tab-' + tab));
  if (tab === 'plan') runPlan(); else renderPlanLines(false);
  if (tab === 'analytics') renderAnalytics();
  if (tab === 'journal') renderJournal();
}
$$('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$$('#tfs button').forEach(b => b.onclick = () => {
  if (ui.tf === b.dataset.tf) return;
  ui.tf = b.dataset.tf; saveUI();
  $$('#tfs button').forEach(x => x.classList.toggle('on', x === b));
  srKey = ''; loadFeed();
});
$$('#inds button').forEach(b => b.onclick = () => { ui[b.dataset.ind] = !ui[b.dataset.ind]; saveUI(); applyVisibility(); });
$$('#tools [data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool, { hline: 'Click the chart to place a horizontal line', trend: 'Click the first point of the trend line', rect: 'Click the first corner of your support/resistance box' }[b.dataset.tool]));
$$('#tools [data-toggle]').forEach(b => b.onclick = () => {
  ui[b.dataset.toggle] = !ui[b.dataset.toggle];
  if (b.dataset.toggle === 'alerts') {
    toast(ui.alerts ? 'Alerts on: S/R zones, your boxes and your horizontal lines.' : 'Alerts off.');
    if (ui.alerts && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  } saveUI(); applyVisibility(); renderSR(); renderMarkers(); renderPlanLines(ui.tab === 'plan' && !planInvalid());
});
$('#tools [data-action=clear]').onclick = () => { if (drawings.length && confirm('Remove all drawings?')) { drawings = []; store.set('drawings', drawings); renderDrawings(); } };
$('#tools [data-action=fit]').onclick = () => chart.timeScale().setVisibleLogicalRange({ from: candles.length - 150, to: candles.length + 8 });
$('#importFile').onchange = async e => { const f = e.target.files[0]; if (f) importCSV(await f.text()); e.target.value = ''; };
$('#exportBtn').onclick = exportCSV;
$('#clearBtn').onclick = () => { if (trades.length && confirm(`Delete all ${trades.length} trades? Export first if you want a backup.`)) { trades = []; saveTrades(); renderJournal(); } };

$('#settingsBtn').onclick = () => {
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(settings)) { const i = f.elements[k]; if (!i) continue; if (i.type === 'checkbox') i.checked = !!v; else i.value = v; }
  $('#settingsDlg').showModal();
};
$('#settingsDlg').addEventListener('close', () => {
  if ($('#settingsDlg').returnValue !== 'save') return;
  const f = $('#settingsForm'), prev = { ...settings };
  settings.provider = f.provider.value; settings.tdKey = f.tdKey.value.trim();
  settings.spotHours = f.spotHours.checked;
  settings.offset = +f.offset.value || 0; settings.balance = +f.balance.value || 10000; settings.risk = +f.risk.value || 1;
  settings.autoClose = f.autoClose.checked;
  settings.spotAlign = f.spotAlign.checked;
  store.set('settings', settings);
  if (prev.provider !== settings.provider || prev.tdKey !== settings.tdKey || prev.offset !== settings.offset || prev.spotHours !== settings.spotHours) loadFeed();
  else if (prev.spotAlign !== settings.spotAlign) { basisSamples = []; lastSpotStamp = null; basis = 0; rebuildDisplay(); calibrateSpot(); }
  else { runPlan(); renderAnalytics(); }
});

// ---------- boot ----------
$$('#tfs button').forEach(b => b.classList.toggle('on', b.dataset.tf === ui.tf));
applyVisibility();
bindPlan();
syncPlanInputs();
setDefaultOpenTime();
setTool('cursor');
setTab(ui.tab);
renderJournal();
loadFeed();
