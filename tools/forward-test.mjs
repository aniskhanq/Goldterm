// Live forward test of GoldTerm's strategies (strategies.js: ORB + SRC on 15m, SWP + CMP on 5m) with Telegram alerts.
//   - heads-up when a signal may trigger on the current 15m candle (up to 15 minutes early)
//   - signal alert with entry / stop / target at fixed 0.1 lots: +$100 target, -$40 stop
//   - paper-trades every signal to its outcome and keeps a running scorecard
// State lives in ../forward/ so restarts never repeat an alert or lose a trade.
// Prices: Binance XAUUSDT 15m candles, shown converted to spot XAU/USD (gold-api.com median basis).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'strategies.js'), 'utf8'));
const DIR = path.join(ROOT, 'forward'); fs.mkdirSync(DIR, { recursive: true });
const STATE = path.join(DIR, 'state.json'), CONFIG = path.join(DIR, 'config.json');
if (!fs.existsSync(CONFIG)) fs.writeFileSync(CONFIG, JSON.stringify({ balance: 5000 }, null, 1));
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { since: Math.floor(Date.now() / 1000), seen: [], watched: [], trades: [] };
st.since5 ??= Math.floor(Date.now() / 1000); // SWP was added later: its forward test starts when it first ran
st.sinceCMP ??= Math.floor(Date.now() / 1000); // likewise CMP
const save = () => {
  fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  const stats = scorecard();
  fs.writeFileSync(path.join(DIR, 'forward.js'), `// Written by tools/forward-test.mjs. Personal data: do not upload.\nwindow.FORWARD = ${JSON.stringify({ updated: Date.now(), since: st.since * 1000, stats, trades: st.trades.slice(-50) })};\n`);
};
const NL = String.fromCharCode(10);
const IST = sec => new Date(sec * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';
const nowSec = () => Math.floor(Date.now() / 1000);
const log = s => console.log(`[${IST(nowSec())}] ${s}`);
const TG = (() => { try { return { tok: fs.readFileSync(path.join(os.homedir(), '.goldterm', 'telegram_token.txt'), 'utf8').trim(), chat: fs.readFileSync(path.join(os.homedir(), '.goldterm', 'telegram_chat_id.txt'), 'utf8').trim() }; } catch { return null; } })();
const telegram = text => TG ? fetch(`https://api.telegram.org/bot${TG.tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG.chat, text }) })
  .then(r => r.json()).then(j => { if (!j.ok) log('telegram failed: ' + j.description); }).catch(e => log('telegram failed: ' + e.message)) : Promise.resolve();

// spot-session filter (same as the backtests): closed Fri 17:00 -> Sun 18:00 New York and daily 17:00-18:00
const nyF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short', hour: '2-digit' });
const spotOpen = s => { const p = {}; for (const x of nyF.formatToParts(new Date(s * 1000))) p[x.type] = x.value; const h = +p.hour, w = p.weekday; return !(w === 'Sat' || (w === 'Fri' && h >= 17) || (w === 'Sun' && h < 18) || h === 17); };
const K = r => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] });
const getJSON = async u => { const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
let bars = [], bars5 = [], basis = null; const samples = [];
// first poll after a restart: events older than 30 min are summarised in one message instead of alerted as if live
let catching = true; const backlog = [];
const stale = sec => catching && nowSec() - sec > 1800;
// later on (e.g. the PC slept through a candle close): still alert, but flagged so a stale entry is never chased
const LATE = 120;
const lateBy = sec => nowSec() - sec > LATE ? Math.round((nowSec() - sec) / 60) : 0;
const nowPrice = () => bars5.length ? bars5[bars5.length - 1].close : bars[bars.length - 1]?.close;

async function calibrate() {
  try {
    const g = await getJSON('https://api.gold-api.com/price/XAU'), p = +(await getJSON('https://fapi.binance.com/fapi/v1/ticker/price?symbol=XAUUSDT')).price;
    if (Date.now() - Date.parse(g.updatedAt) < 120000) { samples.push(+g.price - p); if (samples.length > 9) samples.shift(); const s = [...samples].sort((a, b) => a - b); basis = s[s.length >> 1]; }
  } catch { /* keep last */ }
}
const S = (v, b = basis) => (v + (b ?? 0)).toFixed(2); // perp -> spot for display (b: basis at signal time)
const spotText = (s, b = basis) => s.replace(/\d{4}\.\d{2}/g, m => S(+m, b)); // prices inside notes / heads-ups
// paper trades: fixed 0.1 lots (10 oz, $10 per $1 move), exit the moment the trade is +$100 (a $10 move) or -$40
// (a $4 move). The strategy's own stop and 3R target are kept on the trade as stop0 / tp3R for reference.
const LOTS = 0.1, OZ = LOTS * 100, TARGET_USD = 100, STOP_USD = 40, RULES = 2;
const usdLevel = (entry, dir, usdAmt) => Math.round((entry + dir * usdAmt / OZ) * 100) / 100;
const usdTarget = (entry, dir) => usdLevel(entry, dir, TARGET_USD), usdStop = (entry, dir) => usdLevel(entry, dir, -STOP_USD);
const fixRules = t => { // open trades from older rules switch to the current ones
  if (t.rules === RULES) return;
  t.tp3R ??= t.tp; t.stop0 ??= t.stop;
  Object.assign(t, { lots: LOTS, tp: usdTarget(t.entry, t.dir), stop: usdStop(t.entry, t.dir), rules: RULES });
};
const usd = v => `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;

function scorecard() {
  const out = {};
  for (const name of ['ORB', 'SRC', 'SWP', 'CMP']) {
    const c = st.trades.filter(t => t.strategy === name && t.R != null);
    // equity in $ on the account balance, from the fixed-lot trades only (older trades were sized differently)
    let eq = cfg.balance, peak = eq, dd = 0;
    for (const t of c) if (t.usd != null) { eq += t.usd; peak = Math.max(peak, eq); dd = Math.max(dd, 1 - eq / peak); }
    out[name] = { closed: c.length, open: st.trades.filter(t => t.strategy === name && t.R == null).length, wins: c.filter(t => t.R > 0).length,
                  totalR: c.reduce((a, t) => a + t.R, 0), ret: eq / cfg.balance - 1, maxDD: dd,
                  usd: eq - cfg.balance, usdTrades: c.filter(t => t.usd != null).length };
  }
  return out;
}
const label = s => s === 'ORB' ? 'London open breakout' : s === 'SWP' ? '5m liquidity sweep' : s === 'CMP' ? '5m compression at S/R' : 'S/R + candlestick';
const tfOf = t => t.tf || 900; // candle length in seconds (SWP and CMP trade on 5m, the rest on 15m)

function manageTrades() {
  for (const t of st.trades.filter(x => x.R == null)) {
    fixRules(t); // trades opened before the 0.1-lot / +$100 rules switch to them
    const d = t.dir, tf = tfOf(t), after = (tf === 300 ? bars5 : bars).filter(b => b.time >= t.entryTime);
    for (const b of after) {
      const hs = d === 1 ? b.low <= t.stop : b.high >= t.stop, ht = d === 1 ? b.high >= t.tp : b.low <= t.tp;
      if (hs || ht || b.time - t.entryTime >= (t.hold || 48 * 3600)) {
        const exit = hs ? t.stop : ht ? t.tp : b.close, risk = Math.abs(t.entry - t.stop);
        t.R = Math.round((d * (exit - t.entry) / risk - 0.000075 * t.entry / risk) * 100) / 100;
        t.exit = exit; t.exitTime = b.time; t.result = hs ? 'STOP' : ht ? 'TARGET' : 'TIME';
        t.usd = Math.round(d * (exit - t.entry) * t.lots * 100 * 100) / 100; // gross P&L at the trade's lot size
        const sc = scorecard()[t.strategy];
        const held = Math.max(0, b.time + tf - t.entryTime), hh = held >= 3600 ? `${Math.floor(held / 3600)}h ${Math.round(held % 3600 / 60)}m` : `${Math.round(held / 60)}m`;
        const late = lateBy(b.time + tf);
        const msg = (late ? `⏰ LATE (${late} min, bot was asleep/offline) ` : '') + `${t.result === 'TARGET' ? '✅ TARGET HIT' : t.result === 'STOP' ? '❌ STOPPED OUT' : '⏱ TIME EXIT'}: ${label(t.strategy)} ${d > 0 ? 'BUY' : 'SELL'} @ ${S(t.entry, t.basis)} → ${S(exit, t.basis)} = ${usd(t.usd)} at ${t.lots} lots (${t.R >= 0 ? '+' : ''}${t.R}R)` + NL + `🕒 Opened ${IST(t.entryTime)}, closed ${IST(b.time + tf)} (held ${hh})` + NL +
          `Forward test so far: ${sc.closed} closed, ${sc.wins} wins, ${sc.totalR >= 0 ? '+' : ''}${sc.totalR.toFixed(2)}R · ${usd(sc.usd)} over ${sc.usdTrades} trades at ${LOTS} lots = ${(sc.ret * 100).toFixed(1)}% of $${cfg.balance}, max DD ${(sc.maxDD * 100).toFixed(1)}%`;
        log('OUTCOME ' + msg.split(NL).join(' | '));
        if (stale(b.time + tf)) backlog.push(`${t.result === 'TARGET' ? '✅' : t.result === 'STOP' ? '❌' : '⏱'} ${t.strategy} ${d > 0 ? 'BUY' : 'SELL'} ${IST(t.entryTime)} @ ${S(t.entry, t.basis)} → ${t.result} ${usd(t.usd)}`); else telegram(msg);
        break;
      }
    }
  }
}

function evaluate() {
  const res = GoldStrategies.analyze(bars, { fromTime: st.since }), r5 = GoldStrategies.analyze5(bars5, { fromTime: st.since5 });
  res.signals = res.signals.concat(r5.signals.filter(s => s.strategy !== 'CMP' || s.time >= st.sinceCMP)).sort((a, b) => a.time - b.time); res.watches = res.watches.concat(r5.watches);
  for (const s of res.signals) {
    const id = `${s.strategy}:${s.time}:${s.dir}`;
    if (st.seen.includes(id)) continue;
    st.seen.push(id);
    const tf = s.tf || 900, tp = usdTarget(s.entry, s.dir), stop = usdStop(s.entry, s.dir);
    st.trades.push({ id, strategy: s.strategy, dir: s.dir, signalTime: s.time, entryTime: s.entryTime, entry: s.entry, stop, tp, stop0: s.stop, tp3R: s.tp, lots: LOTS, rules: RULES, basis, note: s.note, R: null, ...(s.tf ? { tf: s.tf, hold: s.hold } : {}) });
    const late = lateBy(s.time + tf);
    const msg = (late ? `⏰ LATE SIGNAL (${late} min after the candle closed, bot was asleep/offline). Price now ~${S(nowPrice())}: only act if it is still near the entry.` + NL : '') +
      `${s.dir > 0 ? '🟢 BUY' : '🔴 SELL'} SIGNAL: ${label(s.strategy)} (XAU/USD ${tf / 60}m)` + NL +
      `Entry ~${S(s.entry)} · Stop ${S(stop)} · Target ${S(tp)}` + NL +
      `${LOTS} lots: +$${TARGET_USD} at target, -$${STOP_USD} if stopped (${(STOP_USD / cfg.balance * 100).toFixed(1)}% of $${cfg.balance})` + NL + `Why: ${spotText(s.note)}` + NL + `🕒 Signal on the ${tf / 60}m candle that closed ${IST(s.time + tf)}` + NL + 'Paper-trading it now; you will get the result.';
    log('SIGNAL ' + msg.split(NL).join(' | '));
    if (stale(s.time + tf)) backlog.push(`${s.dir > 0 ? '🟢' : '🔴'} ${s.strategy} ${s.dir > 0 ? 'BUY' : 'SELL'} signal ${IST(s.time + tf)} @ ${S(s.entry)}`); else telegram(msg);
  }
  for (const w of res.watches) {
    if (st.watched.includes(w.key)) continue;
    st.watched.push(w.key); st.watched = st.watched.slice(-200);
    const win = w.key.startsWith('ORB-armed') ? ` Window: ${IST(nowSec() + 900).split(', ')[1]} to ${IST(nowSec() + 900 + 4 * 3600).split(', ')[1]}.` : '';
    const msg = `⚠️ HEADS-UP (${label(w.strategy)}): ${spotText(w.text)}${win} 🕒 ${IST(nowSec())}`;
    log('WATCH ' + msg); telegram(msg);
  }
  st.seen = st.seen.slice(-500);
}

async function load() {
  // long history so the 1H EMA 200 behind the bias has settled (otherwise signals depend on where the data starts)
  const paged = async (iv, pages) => { let r = [], end = Date.now(); for (let p = 0; p < pages; p++) { const x = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${iv}&limit=1500&endTime=${end}`); if (!x.length) break; r = x.concat(r); end = x[0][0] - 1; } return r.map(K); };
  const r15 = await paged('15m', 4), r5 = await paged('5m', 12);
  rawLast[900] = r15[r15.length - 1].time; rawLast[300] = r5[r5.length - 1].time; // last candle Binance sent, market open or not
  bars = r15.filter(b => spotOpen(b.time)); bars5 = r5.filter(b => spotOpen(b.time));
}
const rawLast = {};
const merge = (arr, rows) => {
  for (const b of rows) {
    const last = arr[arr.length - 1];
    if (last && b.time === last.time) arr[arr.length - 1] = b; else if (!last || b.time > last.time) arr.push(b);
  }
};
let lastOk = nowSec(), busyPoll = false;
async function poll() {
  if (busyPoll) return true; busyPoll = true;
  try {
    const gap = nowSec() - lastOk;
    if (gap > 90) log(`resumed after a ${Math.round(gap / 60)} min gap (PC asleep or offline)`);
    // fetch every candle since the last one we have: after a sleep, only the last 3 would leave holes in the history
    const behind = Math.max(Math.ceil((nowSec() - (rawLast[900] ?? 0)) / 900), Math.ceil((nowSec() - (rawLast[300] ?? 0)) / 300)) + 2;
    if (behind > 1500) { log(`reloading history (${behind} 5m candles behind)`); await load(); }
    for (const [tf, iv] of [[900, '15m'], [300, '5m']]) {
      const n = Math.min(1500, Math.ceil((nowSec() - rawLast[tf]) / tf) + 2), rows = (await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${iv}&limit=${n}`)).map(K);
      if (rows.length) rawLast[tf] = rows[rows.length - 1].time;
      merge(tf === 900 ? bars : bars5, rows.filter(b => spotOpen(b.time)));
    }
    if (bars.length > 5000) bars = bars.slice(-4500);
    if (bars5.length > 13000) bars5 = bars5.slice(-12000);
    manageTrades(); evaluate();
    if (catching) {
      manageTrades(); catching = false; // settle backfilled trades in the same pass
      if (backlog.length) {
        const sc = scorecard(), tot = n => `${sc[n].closed} closed, ${sc[n].wins} wins, ${sc[n].totalR >= 0 ? '+' : ''}${sc[n].totalR.toFixed(2)}R, ${usd(sc[n].usd)}`;
        telegram(`🔁 Forward test back online. While it was offline (not live, do not trade these):` + NL + backlog.slice(-30).join(NL) + NL + `Scorecard: ORB ${tot('ORB')} · SRC ${tot('SRC')} · SWP ${tot('SWP')} · CMP ${tot('CMP')}`);
      }
    }
    save(); lastOk = nowSec(); return true;
  } catch (e) { log('poll error: ' + e.message); return false; }
  finally { busyPoll = false; }
}
// poll 2 s after every 5m candle close (15m closes are 5m closes too), every 20 s in between, 5 s after a failure
function schedule(ok) {
  const now = Date.now(), nextClose = Math.ceil(now / 300000) * 300000 + 2000;
  const wait = ok ? Math.min(20000, nextClose - now) : 5000;
  setTimeout(async () => schedule(await poll()), Math.max(500, wait));
}

await load(); await calibrate();
log(`forward test running: ORB + SRC on XAU/USD 15m, SWP + CMP on 5m, ${bars.length} + ${bars5.length} candles loaded, basis ${basis?.toFixed(2)}, ${st.trades.filter(t => t.R == null).length} open paper trades, since ${new Date(st.since * 1000).toISOString().slice(0, 16)}Z`);
if (!st.started) { st.started = true; telegram(`🧪 Forward test started: London open breakout + S/R candlestick strategies on XAU/USD. You'll get heads-ups (up to 15 min early), signals with entry/stop/3R target, and every paper-trade result.`); }
schedule(await poll());
setInterval(calibrate, 60000);
