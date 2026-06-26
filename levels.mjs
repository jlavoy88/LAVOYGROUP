// ===========================================================================
// ASSAY — intraday gold day-trade levels (free-feed edition, for GitHub Actions).
// Pulls COMEX gold futures (GC=F) OHLC from Yahoo's public chart API, computes
// day-trade reference levels with PLAIN MATH (no AI), then asks Gemini for a
// short intraday read on top. Writes data/levels.json for the site to fetch.
//
//   GEMINI_API_KEY=...  node levels.mjs        (key optional — without it you
//                                               still get all the math levels)
//   SYMBOL=GC=F (default)   OUTPUT_FILE=data/levels.json   INTERVAL_MIN=15
//
// The numbers are computed deterministically from the feed — the model never
// invents prices. Decision-support only, NOT trade signals. Data may be delayed
// ~10–15 min on the free feed; never trade off it without confirming live price.
// ===========================================================================

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const SYMBOL = process.env.SYMBOL || "GC=F";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data/levels.json";
const REFRESH_MIN = Number(process.env.REFRESH_MIN || 240); // run cadence (for "next update"); workflow runs every 4h
const BAR_MIN = Number(process.env.BAR_MIN || 15);          // intraday bar size for session ranges
const API_KEY = process.env.GEMINI_API_KEY;            // optional
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// Session windows in UTC hours [start,end). Approximate (ignores DST by ~1h);
// labelled transparently in the UI. Tweak here if you want tighter windows.
const SESSIONS = {
  asia:   { label: "Asia",   from: 0,  to: 7 },   // ~Tokyo/Sydney
  london: { label: "London", from: 7,  to: 12 },  // London morning → NY open
};

const round1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

// ---- feed -----------------------------------------------------------------

async function yahooChart(interval, range) {
  const path = `/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=${interval}&range=${range}`;
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  let lastErr = "unknown";
  for (const host of hosts) {
    try {
      const res = await fetch(host + path, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
      const txt = await res.text();
      if (!res.ok) { lastErr = `HTTP ${res.status} ${txt.slice(0, 120)}`; continue; }
      const j = JSON.parse(txt);
      const r = j?.chart?.result?.[0];
      if (!r) { lastErr = j?.chart?.error?.description || "no result"; continue; }
      const q = r.indicators?.quote?.[0] || {};
      const ts = r.timestamp || [];
      const bars = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
      })).filter((b) => [b.o, b.h, b.l, b.c].every((v) => typeof v === "number"));
      return { meta: r.meta || {}, bars };
    } catch (e) { lastErr = e.message; }
  }
  throw new Error(`feed failed: ${lastErr}`);
}

// ---- math -----------------------------------------------------------------

function sessionRange(bars, fromH, toH, dayUTC) {
  let hi = -Infinity, lo = Infinity, open = null, close = null;
  for (const b of bars) {
    const d = new Date(b.t);
    if (d.getUTCFullYear() !== dayUTC.y || d.getUTCMonth() !== dayUTC.m || d.getUTCDate() !== dayUTC.d) continue;
    const h = d.getUTCHours();
    if (h < fromH || h >= toH) continue;
    if (open === null) open = b.o;
    close = b.c;
    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;
  }
  if (hi === -Infinity) return null;
  return { high: round1(hi), low: round1(lo), open: round1(open), close: round1(close) };
}

function floorPivots(H, L, C) {
  const P = (H + L + C) / 3, range = H - L;
  return {
    p: round1(P),
    r1: round1(2 * P - L), s1: round1(2 * P - H),
    r2: round1(P + range),  s2: round1(P - range),
    r3: round1(H + 2 * (P - L)), s3: round1(L - 2 * (H - P)),
  };
}

function roundMagnets(price) {
  const out = (step, n) => {
    const base = Math.round(price / step) * step;
    const arr = [];
    for (let k = -n; k <= n; k++) { const v = base + k * step; if (v > 0) arr.push(v); }
    return arr;
  };
  // De-dup across $25/$50/$100 grids, keep within a sensible band of price.
  const set = new Set([...out(25, 3), ...out(50, 2), ...out(100, 1)]);
  return [...set].filter((v) => Math.abs(v - price) <= 80).sort((a, b) => a - b);
}

function computeLevels({ daily, intraday, now }) {
  const price = round1(intraday.meta.regularMarketPrice ?? intraday.bars.at(-1)?.c ?? daily.bars.at(-1)?.c);
  const dBars = daily.bars;
  if (dBars.length < 2) throw new Error("not enough daily bars");

  // Is the last daily bar today's (in-progress)? If so, prior day = the one before.
  const last = dBars.at(-1), lastD = new Date(last.t);
  const isTodayLast = lastD.getUTCFullYear() === now.getUTCFullYear() && lastD.getUTCMonth() === now.getUTCMonth() && lastD.getUTCDate() === now.getUTCDate();
  const prior = isTodayLast ? dBars.at(-2) : dBars.at(-1);

  // ADR(14): avg high-low over the 14 most recent COMPLETED daily bars.
  const completed = isTodayLast ? dBars.slice(0, -1) : dBars;
  const last14 = completed.slice(-14);
  const adr = round1(last14.reduce((s, b) => s + (b.h - b.l), 0) / last14.length);

  // Today's developing range from intraday bars (UTC date of the latest bar).
  const refBar = intraday.bars.at(-1) || last;
  const rd = new Date(refBar.t);
  const dayUTC = { y: rd.getUTCFullYear(), m: rd.getUTCMonth(), d: rd.getUTCDate() };
  let tH = -Infinity, tL = Infinity, tOpen = null;
  for (const b of intraday.bars) {
    const d = new Date(b.t);
    if (d.getUTCFullYear() !== dayUTC.y || d.getUTCMonth() !== dayUTC.m || d.getUTCDate() !== dayUTC.d) continue;
    if (tOpen === null) tOpen = b.o;
    if (b.h > tH) tH = b.h;
    if (b.l < tL) tL = b.l;
  }
  const todayHigh = tH === -Infinity ? null : round1(tH);
  const todayLow = tL === Infinity ? null : round1(tL);
  const todayOpen = round1(tOpen ?? intraday.meta.regularMarketOpen ?? prior.c);
  const usedPts = (todayHigh != null && todayLow != null) ? round1(todayHigh - todayLow) : null;
  const rangeUsedPct = (usedPts != null && adr) ? Math.round((usedPts / adr) * 100) : null;

  const priorClose = round1(prior.c);
  const changePts = price != null && priorClose != null ? round1(price - priorClose) : null;
  const changePct = changePts != null && priorClose ? round1((changePts / priorClose) * 100) : null;

  return {
    symbol: SYMBOL,
    tz: intraday.meta.exchangeTimezoneName || "America/New_York",
    price, priorClose, changePts, changePct,
    today: { open: todayOpen, high: todayHigh, low: todayLow, usedPts, rangeUsedPct },
    adr,
    adrProjection: (adr && todayLow != null && todayHigh != null)
      ? { upFromLow: round1(todayLow + adr), downFromHigh: round1(todayHigh - adr) } : null,
    sessions: {
      asia: sessionRange(intraday.bars, SESSIONS.asia.from, SESSIONS.asia.to, dayUTC),
      london: sessionRange(intraday.bars, SESSIONS.london.from, SESSIONS.london.to, dayUTC),
    },
    priorDay: { high: round1(prior.h), low: round1(prior.l), close: priorClose },
    pivots: floorPivots(prior.h, prior.l, prior.c),
    roundLevels: roundMagnets(price),
  };
}

// ---- AI read (optional, no web search → strict JSON, always parseable) ------

async function geminiRead(L) {
  if (!API_KEY) return null;
  const prompt = `You are a gold (XAU) futures day-trader. Below are TODAY'S computed levels for COMEX gold (${L.symbol}). Do NOT invent numbers — only reference the ones given. Assess the upcoming/current NEW YORK session (COMEX, ~8:20am to 5:00pm ET) and write a concise game plan.

DATA:
price=${L.price} priorClose=${L.priorClose} change=${L.changePts} (${L.changePct}%)
todayOpen=${L.today.open} todayHigh=${L.today.high} todayLow=${L.today.low} rangeUsed=${L.today.rangeUsedPct}% of ADR(${L.adr})
Asia H/L=${L.sessions.asia?.high}/${L.sessions.asia?.low}  London H/L=${L.sessions.london?.high}/${L.sessions.london?.low}
priorDay H/L/C=${L.priorDay.high}/${L.priorDay.low}/${L.priorDay.close}
pivots P=${L.pivots.p} R1=${L.pivots.r1} R2=${L.pivots.r2} S1=${L.pivots.s1} S2=${L.pivots.s2}
nearby round levels=${L.roundLevels.join(", ")}

"probabilityUp" = your calibrated probability (integer 0-100) that gold closes the NY session HIGHER than the current price; 50 = a coin flip. Weigh session structure: where price sits vs the day's range, range already used vs ADR (a near-exhausted range lowers continuation odds), Asia/London highs/lows, prior-day levels, pivots, and momentum. Be honest — if it's balanced, stay near 50.

Respond ONLY with minified JSON, no code fences, exactly:
{"probabilityUp":<integer 0-100>,"bias":"Long|Short|Neutral","confidence":"Low|Medium|High","keyLevel":<number from the data that is the pivotal line in the sand>,"scenarioUp":"<=140 chars: if it holds/breaks above key level, where it goes>","scenarioDown":"<=140 chars: downside scenario>","note":"<=160 chars: range-used / session context caveat>"}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: "application/json" },
  };
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY }, body: JSON.stringify(body) });
    const txt = await res.text();
    if (res.ok) {
      try {
        const data = JSON.parse(txt);
        const t = (data?.candidates?.[0]?.content?.parts || []).filter((p) => typeof p.text === "string").map((p) => p.text).join("");
        const s = t.indexOf("{"), e = t.lastIndexOf("}");
        return JSON.parse(t.slice(s, e + 1));
      } catch (e) { return { error: `read parse: ${e.message}` }; }
    }
    if ([429, 500, 503].includes(res.status) && attempt < 3) { await new Promise((r) => setTimeout(r, attempt * 4000)); continue; }
    return { error: `read HTTP ${res.status}` };
  }
  return { error: "read failed" };
}

// Exported for unit tests (pure math, no network).
export { computeLevels, floorPivots, roundMagnets, sessionRange };

// ---- main -----------------------------------------------------------------

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) (async () => {
  const startedAt = new Date();
  console.log(`[levels] start ${startedAt.toISOString()} — ${SYMBOL}`);
  let out;
  try {
    const [intraday, daily] = await Promise.all([
      yahooChart(`${BAR_MIN}m`, "5d"),
      yahooChart("1d", "2mo"),
    ]);
    const L = computeLevels({ daily, intraday, now: startedAt });
    console.log(`[levels] price ${L.price}  ADR ${L.adr}  rangeUsed ${L.today.rangeUsedPct}%`);
    const read = await geminiRead(L).catch((e) => ({ error: e.message }));
    out = {
      ...L,
      read,
      dataLive: true,
      generatedAt: startedAt.toISOString(),
      nextRunAt: new Date(startedAt.getTime() + REFRESH_MIN * 60 * 1000).toISOString(),
    };
  } catch (e) {
    console.error(`[levels] ERROR ${e.message}`);
    out = { error: e.message, dataLive: false, generatedAt: startedAt.toISOString() };
  }
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[levels] wrote ${OUTPUT_FILE}`);
  if (out.error) process.exit(1);
})();

