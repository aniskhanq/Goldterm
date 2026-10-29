// Backtest of GoldTerm's strategies (strategies.js) with fixed-$ trade management:
//   0.1 lots, +$100 target, and a -$40 / -$45 / -$50 stop, plus each strategy's own stop + 3R target for reference.
// Signals are exactly the ones the live bot gets (same candles, same spot-hours filter); only the exits change.
// Every trade is settled on 5m candles (also the 15m strategies); a candle touching stop and target counts as a stop.
// Usage: node tools/backtest.mjs [--refresh]   (candles are cached in forward/backtest-cache.json)
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'strategies.js'), 'utf8'));
const CACHE = path.join(ROOT, 'forward', 'backtest-cache.json');
const BALANCE = 5000, LOTS = 0.1, OZ = LOTS * 100, TARGET = 100, COST_OZ = 0.30;
const VARIANTS = [{ name: '-$40 stop', stop: 40 }, { name: '-$45 stop', stop: 45 }, { name: '-$50 stop', stop: 50 }, { name: 'strategy stop + 3R', own: true },
  { name: 'strategy stop + 3R, lots sized to risk $45', own: true, riskUsd: 45 },
  { name: '-$100 stop', stop: 100 }, { name: 'strategy stop + 3R, lots sized to risk $100', own: true, riskUsd: 100 }];
const NAMES = { ORB: 'London open breakout (15m)', SRC: 'S/R + candlestick (15m)', SWP: '5m liquidity sweep', CMP: '5m compression at S/R' };

// spot-session filter, same as tools/forward-test.mjs: closed Fri 17:00 -> Sun 18:00 New York and daily 17:00-18:00
const nyF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit' });
const spotOpen = s => { const p = {}; for (const x of nyF.formatToParts(new Date(s * 1000))) p[x.type] = x.value; const h = +p.hour, w = p.weekday; return !(w === 'Sat' || (w === 'Fri' && h >= 17) || (w === 'Sun' && h < 18) || h === 17); };
const K = r => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });

async function all(iv) { // every candle Binance has, oldest first
  let r = [], end = Date.now();
  for (;;) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${iv}&limit=1500&endTime=${end}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const x = await res.json(); if (!x.length) break;
    r = x.concat(r); end = x[0][0] - 1; if (x.length < 1500) break;
  }
  return r.map(K);
}
let data;
if (!process.argv.includes('--refresh') && fs.existsSync(CACHE)) data = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
else { data = { at: Date.now(), b15: await all('15m'), b5: await all('5m') }; fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(data)); }
const last5 = data.b5[data.b5.length - 1].time;
const b15 = data.b15.filter(b => spotOpen(b.time)).slice(0, -1), b5 = data.b5.filter(b => spotOpen(b.time)).slice(0, -1); // drop the forming candle

const { analyze, analyze5 } = globalThis.GoldStrategies;
const signals = analyze(b15, { fromTime: 0 }).signals.concat(analyze5(b5, { fromTime: 0 }).signals).sort((a, b) => a.entryTime - b.entryTime);
const idx5 = new Map(b5.map((b, i) => [b.time, i]));
const first5 = t => { let lo = 0, hi = b5.length; while (lo < hi) { const m = (lo + hi) >> 1; if (b5[m].time < t) lo = m + 1; else hi = m; } return lo; };

function settle(s, v) {
  const d = s.dir, stop = v.own ? s.stop : s.entry - d * v.stop / OZ, tp = v.own ? s.tp : s.entry + d * TARGET / OZ, hold = s.hold || 48 * 3600;
  const oz = v.riskUsd ? Math.max(0.01, Math.floor(v.riskUsd / (Math.abs(s.entry - s.stop) * 100) * 100) / 100) * 100 : OZ; // 0.01-lot steps
  for (let i = idx5.get(s.entryTime) ?? first5(s.entryTime); i < b5.length; i++) {
    const b = b5[i], hs = d > 0 ? b.low <= stop : b.high >= stop, ht = d > 0 ? b.high >= tp : b.low <= tp;
    if (hs || ht || b.time - s.entryTime >= hold) {
      const exit = hs ? stop : ht ? tp : b.close, gross = d * (exit - s.entry) * oz;
      return { s, exitTime: b.time + 300, result: hs ? 'STOP' : ht ? 'TARGET' : 'TIME', both: hs && ht, gross, net: gross - COST_OZ * oz, risk: Math.abs(s.entry - stop) * oz };
    }
  }
  return null; // still open at the end of the data
}
function stats(trades) {
  const n = trades.length, net = trades.reduce((a, t) => a + t.net, 0), gross = trades.reduce((a, t) => a + t.gross, 0);
  const wins = trades.filter(t => t.net > 0), losses = trades.filter(t => t.net <= 0);
  const gw = wins.reduce((a, t) => a + t.net, 0), gl = -losses.reduce((a, t) => a + t.net, 0);
  let eq = BALANCE, peak = eq, dd = 0, ddPct = 0, streak = 0, worst = 0;
  for (const t of [...trades].sort((a, b) => a.exitTime - b.exitTime)) {
    eq += t.net; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); ddPct = Math.max(ddPct, (peak - eq) / peak);
    streak = t.net <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
  }
  return { n, wins: wins.length, winPct: n ? wins.length / n : 0, targets: trades.filter(t => t.result === 'TARGET').length, stops: trades.filter(t => t.result === 'STOP').length,
    times: trades.filter(t => t.result === 'TIME').length, both: trades.filter(t => t.both).length, avgRisk: n ? trades.reduce((a, t) => a + t.risk, 0) / n : 0, net, gross, avg: n ? net / n : 0, pf: gl ? gw / gl : Infinity, dd, ddPct, worst, ret: net / BALANCE };
}

const out = { from: signals.length ? signals[0].entryTime : null, to: last5, bars15: b15.length, bars5: b5.length, signals: signals.length, variants: {} };
for (const v of VARIANTS) {
  const trades = signals.map(s => settle(s, v)).filter(Boolean), row = { all: stats(trades), months: {} };
  for (const k of Object.keys(NAMES)) row[k] = stats(trades.filter(t => t.s.strategy === k));
  for (const t of trades) { const m = new Date(t.exitTime * 1000).toISOString().slice(0, 7); (row.months[m] ??= {})[t.s.strategy] = ((row.months[m] ?? {})[t.s.strategy] || 0) + t.net; }
  out.variants[v.name] = row;
}

const $ = v => (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(0), P = v => (v * 100).toFixed(1) + '%', pf = v => v === Infinity ? '∞' : v.toFixed(2);
const day = t => new Date(t * 1000).toISOString().slice(0, 10);
console.log(`Backtest ${day(out.from)} -> ${day(out.to)} · ${out.signals} signals · ${LOTS} lots · +$${TARGET} target · $${BALANCE} account · cost $${(COST_OZ * OZ).toFixed(2)}/trade`);
for (const [vn, row] of Object.entries(out.variants)) {
  console.log(`\n=== ${vn} === (avg risk per trade $${row.all.avgRisk.toFixed(0)}, ${row.all.both} trades touched stop and target in one 5m candle, counted as stops)`);
  console.log('strategy'.padEnd(28) + 'trades  win%   T/S/time   net      gross    avg    PF    maxDD        streak  return');
  for (const k of [...Object.keys(NAMES), 'all']) {
    const s = row[k];
    console.log((k === 'all' ? 'ALL COMBINED' : NAMES[k]).padEnd(28) + String(s.n).padStart(6) + P(s.winPct).padStart(7) + `${s.targets}/${s.stops}/${s.times}`.padStart(11) +
      $(s.net).padStart(8) + $(s.gross).padStart(9) + $(s.avg).padStart(7) + pf(s.pf).padStart(6) + `${$(-s.dd)} ${P(s.ddPct)}`.padStart(13) + String(s.worst).padStart(7) + P(s.ret).padStart(8));
  }
}
for (const vn of ['-$100 stop', 'strategy stop + 3R, lots sized to risk $100']) {
  console.log(`\nMonthly net $ (${vn}):`);
  const m0 = out.variants[vn].months;
  for (const m of Object.keys(m0).sort()) console.log(m + '  ' + Object.keys(NAMES).map(k => `${k} ${$(m0[m][k] || 0).padStart(6)}`).join('  ') + `  total ${$(Object.values(m0[m]).reduce((a, b) => a + b, 0))}`);
}
fs.writeFileSync(path.join(ROOT, 'forward', 'backtest-results.json'), JSON.stringify(out, null, 1));
