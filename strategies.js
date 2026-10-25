// GoldTerm strategies, shared by the browser app and tools/forward-test.mjs so both always agree.
//   ORB : London open breakout. Range = 01:00-08:00 London time; first 15m close outside it during 08:00-12:00
//         London -> enter next candle, stop at range middle, target 3R. One trade per day.
//   SRC : S/R boxes + bias + candlestick. 1H boxes (swing levels touched 2+ times) and 1H bias score (+/-2 or more);
//         15m bullish/bearish pattern at a box in the bias direction, RSI not stretched, 15m MACD turning, no
//         opposite box within 1.5R. Stop beyond pattern/box + 0.2 x 15m ATR, target 3R.
//   SWP : 5m liquidity sweep at S/R (analyze5). Levels: prior-day high/low, Asian range, 1H swing zones, $25 round
//         numbers. A 5m candle trades 0.2 x ATR through a level untouched for the last hour, then closes back on the
//         original side. Only with the 1H bias (+/-2 or more) and price on the trend side of session VWAP. Stop beyond
//         the sweep wick + 0.3 x ATR, target 3R, max 2 trades a day, exit after 4 hours.
//   CMP : 5m compression at S/R (analyze5). With the 1H bias at +/-3 or more, the last hour of 5m candles forms a
//         range 1.5-5 ATR wide whose capped side (high for shorts, low for longs) sits within 0.5 ATR of a level and
//         was tested 2+ times. Signal on a 5m close 0.1 ATR beyond the other side; stop 0.2 ATR past the capped side,
//         target 3R, max 2 a day, exit after 6 hours. Heads-up as soon as the range is armed.
// analyze(bars15) takes completed + forming 15m candles {time (s), open, high, low, close} and returns
// { signals, watches, boxes, bias } where watches are heads-ups on the forming candle (up to 15 minutes early).
(function (root) {
  'use strict';
  const RR = 3;
  const emaA = (v, p) => { const k = 2 / (p + 1), out = new Array(v.length); let e = v[0]; for (let i = 0; i < v.length; i++) { e = i ? v[i] * k + e * (1 - k) : v[0]; out[i] = e; } return out; };
  function wilder(x, n) {
    const out = new Array(x.length).fill(NaN); if (x.length <= n) return out;
    let a = 0; for (let i = 1; i <= n; i++) a += x[i]; a /= n; out[n] = a;
    for (let i = n + 1; i < x.length; i++) { a = (a * (n - 1) + x[i]) / n; out[i] = a; }
    return out;
  }
  function indicators(b) {
    const o = b.map(x => x.open), h = b.map(x => x.high), l = b.map(x => x.low), c = b.map(x => x.close);
    const tr = c.map((_, i) => i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]);
    const d = c.map((v, i) => i ? v - c[i - 1] : 0);
    const up = wilder(d.map(v => Math.max(v, 0)), 14), dn = wilder(d.map(v => Math.max(-v, 0)), 14);
    const rsi = up.map((u, i) => 100 - 100 / (1 + u / (dn[i] === 0 ? 1e-9 : dn[i])));
    const e12 = emaA(c, 12), e26 = emaA(c, 26), macd = c.map((_, i) => e12[i] - e26[i]), sig = emaA(macd, 9);
    return { o, h, l, c, atr: wilder(tr, 14), e20: emaA(c, 20), e50: emaA(c, 50), e200: emaA(c, 200), rsi, hist: macd.map((m, i) => m - sig[i]) };
  }
  function toHours(b15) { // 1H candles from 15m candles (hour of the candle start)
    const out = [];
    for (const x of b15) {
      const t = Math.floor(x.time / 3600) * 3600, last = out[out.length - 1];
      if (last && last.time === t) { last.high = Math.max(last.high, x.high); last.low = Math.min(last.low, x.low); last.close = x.close; }
      else out.push({ time: t, open: x.open, high: x.high, low: x.low, close: x.close });
    }
    return out;
  }
  const londonFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  function london(sec) { const p = {}; for (const x of londonFmt.formatToParts(new Date(sec * 1000))) p[x.type] = x.value; return { day: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; }

  function pattern(X, t, d) {
    const o = X.o[t], h = X.h[t], l = X.l[t], c = X.c[t], a = X.atr[t], rng = h - l, body = Math.abs(c - o);
    if (!(rng > 0) || !(a > 0)) return null;
    const upW = h - Math.max(o, c), loW = Math.min(o, c) - l;
    if (d === 1) {
      if (rng >= 0.6 * a && loW >= 2 * Math.max(body, 0.05 * a) && upW <= Math.max(body, 0.25 * rng) && c >= l + 2 / 3 * rng) return 'hammer';
      if (X.c[t - 1] < X.o[t - 1] && c > o && o <= X.c[t - 1] && c >= X.o[t - 1] && body >= 0.3 * a) return 'bullish engulfing';
      const b2 = X.o[t - 2] - X.c[t - 2];
      if (b2 >= 0.5 * a && Math.abs(X.c[t - 1] - X.o[t - 1]) <= 0.3 * b2 && c > o && c > X.c[t - 2] + b2 / 2) return 'morning star';
      if (c > o && body >= 0.7 * rng && body >= 0.8 * a) return 'strong bullish candle';
    } else {
      if (rng >= 0.6 * a && upW >= 2 * Math.max(body, 0.05 * a) && loW <= Math.max(body, 0.25 * rng) && c <= h - 2 / 3 * rng) return 'shooting star';
      if (X.c[t - 1] > X.o[t - 1] && c < o && o >= X.c[t - 1] && c <= X.o[t - 1] && body >= 0.3 * a) return 'bearish engulfing';
      const b2 = X.c[t - 2] - X.o[t - 2];
      if (b2 >= 0.5 * a && Math.abs(X.c[t - 1] - X.o[t - 1]) <= 0.3 * b2 && c < o && c < X.c[t - 2] - b2 / 2) return 'evening star';
      if (c < o && body >= 0.7 * rng && body >= 0.8 * a) return 'strong bearish candle';
    }
    return null;
  }

  function analyze(bars15, opts = {}) {
    const fromTime = opts.fromTime || 0;
    const done = bars15.slice(0, -1), forming = bars15[bars15.length - 1]; // last candle is still forming
    const signals = [], watches = [];
    if (done.length < 300) return { signals, watches, boxes: [], bias: null };
    const X = indicators(done);
    // ---------- ORB: London open breakout ----------
    const days = new Map();
    done.forEach((b, i) => { const L = london(b.time); (days.get(L.day) || days.set(L.day, []).get(L.day)).push([i, L.min]); });
    for (const [day, list] of days) {
      const rng = list.filter(([, m]) => m >= 60 && m < 480).map(([i]) => i);
      const win = list.filter(([, m]) => m >= 480 && m < 720).map(([i]) => i);
      if (rng.length < 3) continue;
      const hi = Math.max(...rng.map(i => X.h[i])), lo = Math.min(...rng.map(i => X.l[i])), mid = (hi + lo) / 2;
      let fired = false;
      for (const i of win) {
        const d = X.c[i] > hi ? 1 : X.c[i] < lo ? -1 : 0;
        if (!d) continue;
        fired = true;
        const entryBar = done[i + 1] || forming, entry = entryBar.open, stop = mid, risk = d * (entry - stop);
        if (risk > 0 && done[i].time >= fromTime) signals.push({ strategy: 'ORB', name: 'London open breakout', dir: d, time: done[i].time, entryTime: entryBar.time, entry, stop, tp: entry + d * RR * risk, note: `close ${d > 0 ? 'above' : 'below'} the Asian range ${lo.toFixed(2)}-${hi.toFixed(2)}` });
        break;
      }
      // heads-up: today's window is open (or about to be), no breakout yet
      const F = london(forming.time);
      if (!fired && day === F.day && F.min >= 465 && F.min < 720) {
        const near = Math.max(0.15 * (hi - lo), 1.5);
        if (F.min < 480) watches.push({ strategy: 'ORB', dir: 0, time: forming.time, key: `ORB-armed-${day}`, text: `London breakout window opens in 15 min. BUY on a 15m close above ${hi.toFixed(2)}, SELL on a close below ${lo.toFixed(2)} (stop ${mid.toFixed(2)}).` });
        else if (forming.high >= hi - near || forming.close >= hi - near) watches.push({ strategy: 'ORB', dir: 1, time: forming.time, key: `ORB-${day}-${forming.time}-1`, text: `Possible London BUY: price ${forming.close.toFixed(2)} is pressing the range high ${hi.toFixed(2)}. Signal if this 15m candle closes above it.` });
        else if (forming.low <= lo + near || forming.close <= lo + near) watches.push({ strategy: 'ORB', dir: -1, time: forming.time, key: `ORB-${day}-${forming.time}--1`, text: `Possible London SELL: price ${forming.close.toFixed(2)} is pressing the range low ${lo.toFixed(2)}. Signal if this 15m candle closes below it.` });
      }
    }
    // ---------- SRC: 1H boxes + bias + 15m candlestick ----------
    const h1 = toHours(done), H = indicators(h1);
    const piv = [];
    for (let i = 13; i < h1.length - 3; i++) {
      const a = H.atr[i]; if (!(a > 0)) continue;
      // reaction measured only on candles known when the level becomes usable (i+4): no look-ahead
      const lo10 = Math.min(...H.l.slice(Math.max(0, i - 10), i + 4)), hi10 = Math.max(...H.h.slice(Math.max(0, i - 10), i + 4));
      if ([1, 2, 3].every(j => H.h[i] >= H.h[i - j]) && [1, 2, 3].every(j => H.h[i] > H.h[i + j]) && H.h[i] - lo10 >= a) piv.push([i, H.h[i]]);
      if ([1, 2, 3].every(j => H.l[i] <= H.l[i - j]) && [1, 2, 3].every(j => H.l[i] < H.l[i + j]) && hi10 - H.l[i] >= a) piv.push([i, H.l[i]]);
    }
    const bias = k => (H.c[k] > H.e50[k] ? 1 : -1) + (H.e50[k] > H.e200[k] ? 1 : -1) + (H.e20[k] > H.e20[k - 5] ? 1 : -1)
      + (H.rsi[k] > 55 ? 1 : H.rsi[k] < 45 ? -1 : 0) + (H.hist[k] > 0 ? 1 : -1);
    const zonesAt = t => { // boxes known at 1H bar t (pivots confirmed 4+ bars earlier, last 400 bars)
      const a = H.atr[t - 1]; if (!(a > 0)) return [];
      const ps = piv.filter(([i]) => i + 4 <= t && i >= t - 400).map(([, p]) => p).sort((x, y) => x - y);
      const out = []; let cur = [];
      for (const p of ps) { if (cur.length && p - cur.reduce((s, v) => s + v, 0) / cur.length > 0.35 * a) { out.push(cur); cur = []; } cur.push(p); }
      if (cur.length) out.push(cur);
      return out.filter(g => g.length >= 2).map(g => { const m = g.reduce((s, v) => s + v, 0) / g.length; return { lo: m - 0.15 * a, hi: m + 0.15 * a, touches: g.length }; });
    };
    const hourIdx = new Map(h1.map((b, i) => [b.time, i]));
    const checkSRC = (t, B, X15, k, final) => { // t: 15m index in X15 (B = candle), k: last completed 1H index
      const b = bias(k); if (Math.abs(b) < 2) return null;
      const d = b > 0 ? 1 : -1, a = X15.atr[t];
      if (!(a > 0)) return null;
      const pat = final ? pattern(X15, t, d) : 'forming';
      if (!pat) return null;
      if (final && ((d === 1 && X15.rsi[t] >= 70) || (d === -1 && X15.rsi[t] <= 30))) return null;
      if (final && d * (X15.hist[t] - X15.hist[t - 1]) <= 0) return null;
      const zs = zonesAt(k + 1);
      let hit = null, kind = null;
      for (const z of zs) {
        if (d === 1 && B.low <= z.hi && B.close > z.hi && z.lo <= B.low + 2 * a) { hit = z; kind = 'bounce/retest'; }
        else if (d === -1 && B.high >= z.lo && B.close < z.lo && z.hi >= B.high - 2 * a) { hit = z; kind = 'bounce/retest'; }
        else if (d === 1 && B.open <= z.hi && B.close > z.hi + 0.1 * a) { hit = z; kind = 'breakout'; }
        else if (d === -1 && B.open >= z.lo && B.close < z.lo - 0.1 * a) { hit = z; kind = 'breakdown'; }
        if (hit) break;
      }
      if (!hit) return null;
      return { d, b, a, pat, kind, hit, zs };
    };
    const X15 = X;
    for (let t = 400; t < done.length; t++) {
      const k = (hourIdx.get(Math.floor(done[t].time / 3600) * 3600) ?? -1) - 1;
      if (k < 210) continue;
      const r = checkSRC(t, done[t], X15, k, true);
      if (!r) continue;
      const entryBar = done[t + 1] || forming, entry = entryBar.open;
      const stop = r.d === 1 ? Math.min(done[t].low, r.hit.lo) - 0.2 * r.a : Math.max(done[t].high, r.hit.hi) + 0.2 * r.a;
      const risk = r.d * (entry - stop);
      if (!(risk >= 0.4 * r.a && risk <= 3 * r.a)) continue;
      if (r.zs.some(z => z !== r.hit && 0 < r.d * ((r.d === 1 ? z.lo : z.hi) - entry) && r.d * ((r.d === 1 ? z.lo : z.hi) - entry) < 1.5 * risk)) continue;
      if (done[t].time >= fromTime) signals.push({ strategy: 'SRC', name: 'S/R + candlestick', dir: r.d, time: done[t].time, entryTime: entryBar.time, entry, stop, tp: entry + r.d * RR * risk,
        note: `${r.pat} at ${r.kind === 'bounce/retest' ? (r.d > 0 ? 'support' : 'resistance') : 'a ' + r.kind + ' of'} ${r.hit.lo.toFixed(2)}-${r.hit.hi.toFixed(2)}, 1H bias ${r.b > 0 ? '+' : ''}${r.b}` });
    }
    // heads-up on the forming 15m candle: bias + box interaction + room to run are already in place
    const kNow = (hourIdx.get(Math.floor(forming.time / 3600) * 3600) ?? h1.length) - 1;
    const kUse = Math.min(kNow, h1.length - 1);
    let bNow = null, boxes = [];
    if (kUse >= 210) {
      bNow = bias(kUse); boxes = zonesAt(kUse + 1);
      const r = checkSRC(done.length - 1, forming, X15, kUse, false);
      if (r) {
        const stop = r.d === 1 ? Math.min(forming.low, r.hit.lo) - 0.2 * r.a : Math.max(forming.high, r.hit.hi) + 0.2 * r.a, risk = r.d * (forming.close - stop);
        const blocked = r.zs.some(z => z !== r.hit && 0 < r.d * ((r.d === 1 ? z.lo : z.hi) - forming.close) && r.d * ((r.d === 1 ? z.lo : z.hi) - forming.close) < 1.5 * risk);
        if (!blocked && risk >= 0.4 * r.a && risk <= 3 * r.a) watches.push({ strategy: 'SRC', dir: r.d, time: forming.time, key: `SRC-${forming.time}-${r.d}`,
          text: `Possible ${r.d > 0 ? 'BUY' : 'SELL'} (S/R + candle): price is at the ${r.d > 0 ? 'support' : 'resistance'} box ${r.hit.lo.toFixed(2)}-${r.hit.hi.toFixed(2)} with 1H bias ${r.b > 0 ? '+' : ''}${r.b}. Signal if this 15m candle closes ${r.d > 0 ? 'above ' + r.hit.hi.toFixed(2) : 'below ' + r.hit.lo.toFixed(2)} as a ${r.d > 0 ? 'bullish' : 'bearish'} pattern (hammer/engulfing/strong candle).` });
      }
    }
    signals.sort((x, y) => x.time - y.time);
    return { signals, watches, boxes, bias: bNow };
  }
  // ---------- SWP: 5m liquidity sweep (bars5: completed + forming, spot hours only, {time, open, high, low, close, volume}) ----------
  const nyDayF = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
  function tradingDay(sec) { // NY date, rolled forward after the 17:00 close
    const p = {}; for (const x of nyDayF.formatToParts(new Date(sec * 1000))) p[x.type] = x.value;
    return new Date(Date.UTC(+p.year, +p.month - 1, +p.day) + (+p.hour >= 18 ? 86400000 : 0)).toISOString().slice(0, 10);
  }
  const SWP = { pen: 0.2, buf: 0.3, look: 12, maxDay: 2, hold: 4 * 3600, warm: 6000 };
  const CMP = { W: 12, maxW: 5, tests: 2, tol: 0.5, buf: 0.2, bias: 3, maxDay: 2, hold: 6 * 3600 };
  function analyze5(bars5, opts = {}) {
    const fromTime = opts.fromTime || 0, signals = [], watches = [];
    // the 1H EMA 200 in the bias needs ~500 hours to settle: with less history, signals would depend on where the data starts
    if (bars5.length < SWP.warm + 1000) return { signals, watches, levels: [] };
    const B = bars5, N = B.length, X = indicators(B), day = B.map(b => tradingDay(b.time)), lmin = B.map(b => london(b.time).min);
    const vwap = []; { let pv = 0, vv = 0; for (let i = 0; i < N; i++) { if (!i || day[i] !== day[i - 1]) { pv = 0; vv = 0; } const v = B[i].volume || 1; pv += (B[i].high + B[i].low + B[i].close) / 3 * v; vv += v; vwap.push(pv / vv); } }
    const h1 = [], hIdx = [];
    for (const b of B) { const t = Math.floor(b.time / 3600) * 3600, last = h1[h1.length - 1]; if (last && last.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; } else h1.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close }); hIdx.push(h1.length - 1); }
    const H = indicators(h1);
    const bias = k => k < 210 ? 0 : (H.c[k] > H.e50[k] ? 1 : -1) + (H.e50[k] > H.e200[k] ? 1 : -1) + (H.e20[k] > H.e20[k - 5] ? 1 : -1) + (H.rsi[k] > 55 ? 1 : H.rsi[k] < 45 ? -1 : 0) + (H.hist[k] > 0 ? 1 : -1);
    const piv = [];
    for (let i = 13; i < h1.length - 3; i++) {
      const a = H.atr[i]; if (!(a > 0)) continue;
      const lo10 = Math.min(...H.l.slice(i - 10, i + 4)), hi10 = Math.max(...H.h.slice(i - 10, i + 4));
      if ([1, 2, 3].every(j => H.h[i] >= H.h[i - j] && H.h[i] > H.h[i + j]) && H.h[i] - lo10 >= a) piv.push([i, H.h[i]]);
      if ([1, 2, 3].every(j => H.l[i] <= H.l[i - j] && H.l[i] < H.l[i + j]) && hi10 - H.l[i] >= a) piv.push([i, H.l[i]]);
    }
    const zc = new Map(), zonesAt = k => { // swing zones known after 1H bar k closes
      if (zc.has(k)) return zc.get(k);
      const a = H.atr[k], g = []; let cur = [];
      if (a > 0) for (const p of piv.filter(([i]) => i + 4 <= k + 1 && i >= k - 400).map(([, p]) => p).sort((x, y) => x - y)) { if (cur.length && p - cur.reduce((s, v) => s + v, 0) / cur.length > 0.35 * a) { g.push(cur); cur = []; } cur.push(p); }
      if (cur.length) g.push(cur);
      const out = g.filter(x => x.length >= 2).map(x => ({ p: x.reduce((s, v) => s + v, 0) / x.length, kind: '1H swing zone' }));
      zc.set(k, out); return out;
    };
    const dayHL = new Map(), asia = new Map();
    B.forEach((b, i) => {
      const x = dayHL.get(day[i]) || dayHL.set(day[i], { h: -Infinity, l: Infinity }).get(day[i]); x.h = Math.max(x.h, b.high); x.l = Math.min(x.l, b.low);
      if (lmin[i] < 420) { const y = asia.get(day[i]) || asia.set(day[i], { h: -Infinity, l: Infinity, n: 0 }).get(day[i]); y.h = Math.max(y.h, b.high); y.l = Math.min(y.l, b.low); y.n++; }
    });
    const days = [...dayHL.keys()], prev = new Map(days.map((d, i) => [d, days[i - 1]]));
    const levelsAt = (i, ref) => { // levels known at candle i (prior-day and Asian ranges use only finished data)
      const L = [], pd = dayHL.get(prev.get(day[i])), as = asia.get(day[i]);
      if (pd) L.push({ p: pd.h, kind: 'prior-day high' }, { p: pd.l, kind: 'prior-day low' });
      if (as && as.n > 30 && lmin[i] >= 420) L.push({ p: as.h, kind: 'Asian high' }, { p: as.l, kind: 'Asian low' });
      L.push(...zonesAt(hIdx[i] - 1));
      const r = Math.round(ref / 25) * 25; L.push({ p: r - 25, kind: 'round number' }, { p: r, kind: 'round number' }, { p: r + 25, kind: 'round number' });
      return L;
    };
    // final: closed candle i; otherwise the forming candle (heads-up). Returns the first qualifying sweep.
    const check = (i, final) => {
      const a = X.atr[final ? i : i - 1]; if (!(a > 0)) return null;
      const b = B[i], bs = bias(hIdx[i] - 1);
      if (Math.abs(bs) < 2) return null;
      const d = bs > 0 ? 1 : -1;
      if (!(d * (b.close - vwap[i]) > 0)) return null;
      for (const lv of levelsAt(i, final ? b.close : B[i - 1].close)) {
        const L = lv.p; let clean = true;
        for (let j = i - SWP.look; j < i; j++) if (d === 1 ? B[j].low < L : B[j].high > L) { clean = false; break; }
        if (!clean) continue;
        const swept = d === 1 ? b.low <= L - SWP.pen * a && b.open > L : b.high >= L + SWP.pen * a && b.open < L;
        if (!swept) continue;
        const stop = d === 1 ? b.low - SWP.buf * a : b.high + SWP.buf * a;
        if (final && !(d * (b.close - L) > 0)) continue;
        return { d, a, L, lv, stop, bs };
      }
      return null;
    };
    const perDay = new Map(); let busy = -1;
    for (let i = SWP.warm; i < N - 1; i++) {
      if (i <= busy || (perDay.get(day[i]) || 0) >= SWP.maxDay) continue;
      const r = check(i, true); if (!r) continue;
      const entryBar = B[i + 1], entry = entryBar.open, risk = r.d * (entry - r.stop);
      if (!(risk >= 0.5 * r.a && risk <= 3 * r.a && risk >= 1.5)) continue;
      perDay.set(day[i], (perDay.get(day[i]) || 0) + 1);
      // the same position stays open until stop, target or the 4-hour exit, so skip candles inside it
      let j = i + 1; const tp = entry + r.d * RR * risk;
      for (; j < N - 1 && B[j].time - entryBar.time < SWP.hold; j++) if (r.d === 1 ? B[j].low <= r.stop || B[j].high >= tp : B[j].high >= r.stop || B[j].low <= tp) break;
      busy = j;
      if (B[i].time >= fromTime) signals.push({ strategy: 'SWP', name: '5m liquidity sweep', tf: 300, hold: SWP.hold, dir: r.d, time: B[i].time, entryTime: entryBar.time, entry, stop: r.stop, tp,
        note: `swept the ${r.lv.kind} ${r.L.toFixed(2)} and closed back ${r.d > 0 ? 'above' : 'below'} it, ${r.d > 0 ? 'above' : 'below'} VWAP ${vwap[i].toFixed(2)}, 1H bias ${r.bs > 0 ? '+' : ''}${r.bs}` });
    }
    // ---------- CMP: compression under resistance / over support, in the 1H trend ----------
    const rangeAt = i => { // the CMP.W candles before i: a tight range whose capped side sits at an S/R level
      const a = X.atr[i], bs = bias(hIdx[i] - 1); if (!(a > 0) || Math.abs(bs) < CMP.bias) return null;
      const d = bs > 0 ? 1 : -1; let hi = -Infinity, lo = Infinity;
      for (let j = i - CMP.W; j < i; j++) { hi = Math.max(hi, B[j].high); lo = Math.min(lo, B[j].low); }
      if (hi - lo > CMP.maxW * a || hi - lo < 1.5 * a) return null;
      const edge = d === -1 ? hi : lo, inner = d === -1 ? lo : hi; let tests = 0;
      for (let j = i - CMP.W; j < i; j++) if (d === -1 ? B[j].high >= hi - 0.3 * a : B[j].low <= lo + 0.3 * a) tests++;
      if (tests < CMP.tests) return null;
      const lv = levelsAt(i - CMP.W, B[i - CMP.W].close).concat(levelsAt(i, B[i].close)).find(x => Math.abs(x.p - edge) <= CMP.tol * a);
      return lv ? { d, a, bs, hi, lo, edge, inner, tests, lv, stop: edge - d * CMP.buf * a } : null;
    };
    const perDayC = new Map(); let busyC = -1;
    for (let i = SWP.warm; i < N - 1; i++) {
      if (i <= busyC || (perDayC.get(day[i]) || 0) >= CMP.maxDay) continue;
      const r = rangeAt(i); if (!r || !(r.d * (B[i].close - r.inner) > 0.1 * r.a)) continue;
      const entryBar = B[i + 1], entry = entryBar.open, risk = r.d * (entry - r.stop);
      if (!(risk >= 1.5 && risk >= 0.5 * r.a && risk <= 6 * r.a)) continue;
      perDayC.set(day[i], (perDayC.get(day[i]) || 0) + 1);
      let j = i + 1; const tp = entry + r.d * RR * risk;
      for (; j < N - 1 && B[j].time - entryBar.time < CMP.hold; j++) if (r.d === 1 ? B[j].low <= r.stop || B[j].high >= tp : B[j].high >= r.stop || B[j].low <= tp) break;
      busyC = j;
      if (B[i].time >= fromTime) signals.push({ strategy: 'CMP', name: '5m compression at S/R', tf: 300, hold: CMP.hold, dir: r.d, time: B[i].time, entryTime: entryBar.time, entry, stop: r.stop, tp,
        note: `${r.d < 0 ? 'broke down from' : 'broke out of'} a 1-hour range ${r.lo.toFixed(2)}-${r.hi.toFixed(2)} ${r.d < 0 ? 'capped by' : 'held by'} the ${r.lv.kind} ${r.lv.p.toFixed(2)} (${r.tests} tests), 1H bias ${r.bs > 0 ? '+' : ''}${r.bs}` });
    }
    const f = N - 1;
    if (f > busyC && (perDayC.get(day[f]) || 0) < CMP.maxDay) { // heads-ups: the range is armed, then price is pressing its trigger side
      const r = rangeAt(f);
      if (r && B[f].close > r.lo && B[f].close < r.hi) { // still coiling inside the range
        const side = r.d < 0 ? 'SELL' : 'BUY', trig = `${r.d < 0 ? 'below' : 'above'} ${r.inner.toFixed(2)}`, risk = Math.abs(r.inner - r.stop);
        watches.push({ strategy: 'CMP', dir: 0, time: B[f].time, key: `CMP-armed-${day[f]}-${r.d}-${Math.round(r.lv.p)}`,
          text: `${side} setup armed (5m compression at S/R): price is coiling in ${r.lo.toFixed(2)}-${r.hi.toFixed(2)} ${r.d < 0 ? 'under the resistance' : 'over the support'} ${r.lv.kind} ${r.lv.p.toFixed(2)} (${r.tests} tests) with 1H bias ${r.bs > 0 ? '+' : ''}${r.bs}. Trigger: a 5m close ${trig}. Stop ~${r.stop.toFixed(2)}, target ~${(r.inner + r.d * RR * risk).toFixed(2)} (3R).` });
        if (r.d * (r.inner - B[f].close) <= 0.5 * r.a) watches.push({ strategy: 'CMP', dir: r.d, time: B[f].time, key: `CMP-${B[f].time}-${r.d}`,
          text: `Possible ${side} (5m compression at S/R): price ${B[f].close.toFixed(2)} is pressing the range ${r.d < 0 ? 'low' : 'high'}. Signal if this 5m candle closes ${trig} (stop ~${r.stop.toFixed(2)}).` });
      }
    }
    if (f > busy && (perDay.get(day[f]) || 0) < SWP.maxDay) {
      const r = check(f, false);
      if (r) watches.push({ strategy: 'SWP', dir: r.d, time: B[f].time, key: `SWP-${B[f].time}-${r.d}`,
        text: `Possible ${r.d > 0 ? 'BUY' : 'SELL'} (5m liquidity sweep): price just swept the ${r.lv.kind} ${r.L.toFixed(2)}. Signal if this 5m candle closes back ${r.d > 0 ? 'above' : 'below'} ${r.L.toFixed(2)} (stop ~${r.stop.toFixed(2)}).` });
    }
    signals.sort((x, y) => x.time - y.time);
    return { signals, watches, levels: levelsAt(f, B[f].close), vwap: vwap[f] };
  }
  root.GoldStrategies = { analyze, analyze5, RR, version: 2 };
})(typeof window !== 'undefined' ? window : globalThis);
