// ===========================================================================
// ASSAY — one-shot gold scan for GitHub Actions (Gemini / free-tier edition).
// Runs all gold lenses on a WEEKLY horizon and writes the result to a JSON file
// that the static site fetches. No server required.
//
//   GEMINI_API_KEY=...  node scan.mjs
//   OUTPUT_FILE=data/latest.json (default)
//   GEMINI_MODEL=gemini-flash-latest (default; any free-tier Flash works)
//
// Uses Google's Gemini API with Grounding (google_search) for live data.
// Output JSON shape is IDENTICAL to the Anthropic version, so the homepage
// panel needs no changes. Keep the LENSES below in sync with the panel by id.
// ===========================================================================

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash"; // stable, free-tier, supports grounding
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data/latest.json";
const SCAN_INTERVAL_HOURS = Number(process.env.SCAN_INTERVAL_HOURS || 4);
const HORIZON_PHRASE = "the next week (a one-week outlook)";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!API_KEY) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }

const LENSES = {
  gold: { role: "headline", name: "Gold", focus: "Spot gold (XAU/USD). Synthesize the dominant macro drivers: 10-year real (TIPS) yields, the US dollar (DXY), the Fed rate-path / cut expectations, safe-haven and geopolitical risk demand, and central-bank / physical demand. Weigh them into one calibrated directional view for the gold price." },
  realyields: { role: "lens", name: "Real Yields", focus: "10-year US real (inflation-protected / TIPS) yields plus inflation breakevens — gold's single most important driver. FALLING real yields lower the opportunity cost of holding non-yielding gold and are BULLISH for gold; RISING real yields are a headwind." },
  usd: { role: "lens", name: "US Dollar", focus: "The US dollar (DXY index and the broad dollar). Gold is priced in dollars, so a WEAKER dollar is generally BULLISH for gold and a STRONGER dollar is a headwind. Weigh the dollar's trend, rate differentials, and momentum." },
  fed: { role: "lens", name: "Fed & Rate Path", focus: "Federal Reserve policy and the forward rate path — fed funds futures, rate-cut/hike odds, the dot plot, and Fed rhetoric. A DOVISH path (cuts, easier policy) is BULLISH for gold; a HAWKISH path is a headwind." },
  haven: { role: "lens", name: "Safe Haven & Geopolitics", focus: "Safe-haven demand: equity-market risk (VIX), credit/financial stress, and active geopolitical or conflict risk. RISK-OFF conditions and rising geopolitical tension are BULLISH for gold; calm risk-on is a mild headwind." },
  cbdemand: { role: "lens", name: "Central-Bank & Physical Demand", focus: "Official-sector (central bank) gold buying, gold ETF holdings/flows (e.g. GLD), and physical demand from China and India. STRONG official and physical buying is structurally BULLISH for gold; outflows / weak demand are a headwind." },
};

function buildPrompt(lens, useSearch) {
  const dataLine = useSearch
    ? "Research CURRENT conditions using Google Search before answering. Use real, current data you find; do not invent figures."
    : "You do NOT have live data access right now. Reason from your general knowledge of recent conditions, keep probabilities closer to 50, and do not state specific live figures as if confirmed.";
  const framing = lens.role === "headline"
    ? `Assess the probable price DIRECTION of gold over ${HORIZON_PHRASE}. "probabilityUp" = probability gold is HIGHER one week from now (50 = a coin flip).`
    : `Assess whether this factor is currently a TAILWIND or HEADWIND for GOLD over ${HORIZON_PHRASE}. Express EVERYTHING in terms of gold: lean "Bullish" = supportive of HIGHER gold; "Bearish" = a headwind for gold. "probabilityUp" = probability this factor is net BULLISH for gold over the week (50 = neutral).`;
  return `You are a macro analyst who trades gold by reading its cross-asset drivers — real yields, the dollar, Fed policy, safe-haven flows, and physical/central-bank demand — then forms a calibrated view. ${dataLine}

Focus: ${lens.focus}

Task: ${framing} Be calibrated and intellectually honest — if signals conflict or are unclear, keep the probability near 50 and say so.

Respond with ONLY a JSON object — no prose, no code fences — matching exactly:
{"commodity":"${lens.name}","asOf":"YYYY-MM-DD","lean":"Bullish|Bearish|Neutral","probabilityUp":<integer 0-100>,"confidence":"Low|Medium|High","drivers":[{"factor":"<short label>","signal":"bull|bear|neutral","note":"<=90 chars, in terms of gold"}],"read":"<=240 chars, one-week implication for gold"}

Include 3 to 4 drivers. Output JSON only.`;
}

// Concatenate every text part Gemini returns (skips thought / non-text parts).
function combineText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => p && typeof p.text === "string").map((p) => p.text).join("\n");
}
function extractJSON(raw) {
  let t = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s !== -1 && e !== -1 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(lens, useSearch) {
  const body = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(lens, useSearch) }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 3000 },
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  // Retry transient errors (overloaded / rate-limited): 429, 500, 503.
  const MAX_TRIES = 3;
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify(body),
    });
    const rawText = await res.text();
    if (res.ok) {
      const data = JSON.parse(rawText);
      if (data.error) throw new Error(`api error — ${data.error.message || "unknown"}`);
      const cand = data?.candidates?.[0];
      const text = combineText(data);
      if (!text.trim()) {
        const reason = cand?.finishReason || data?.promptFeedback?.blockReason || "no text";
        throw new Error(`no text out (finish=${reason})`);
      }
      return text;
    }
    // not ok
    let msg = `HTTP ${res.status}`;
    try { const e = JSON.parse(rawText); if (e?.error?.message) msg = `HTTP ${res.status} — ${e.error.message}`; }
    catch (_) { if (rawText) msg = `HTTP ${res.status} — ${rawText.slice(0, 160)}`; }
    lastErr = msg;
    const transient = res.status === 429 || res.status === 500 || res.status === 503;
    if (transient && attempt < MAX_TRIES) { await sleep(attempt * 5000); continue; } // 5s, 10s backoff
    throw new Error(msg);
  }
  throw new Error(lastErr);
}

async function analyzeLens(lensId) {
  const lens = LENSES[lensId];
  const log = []; let parsed = null, live = true;
  try { const t = await callGemini(lens, true); try { parsed = extractJSON(t); } catch (pe) { log.push(`live-parse: ${pe.message}`); } }
  catch (e) { log.push(`live: ${e.message}`); }
  if (!parsed) { live = false; try { const t2 = await callGemini(lens, false); try { parsed = extractJSON(t2); } catch (pe) { log.push(`offline-parse: ${pe.message}`); } } catch (e2) { log.push(`offline: ${e2.message}`); } }
  if (!parsed) throw new Error(log.join("  |  "));
  parsed.live = live;
  parsed.probabilityUp = Math.max(0, Math.min(100, Math.round(Number(parsed.probabilityUp) || 50)));
  if (!Array.isArray(parsed.drivers)) parsed.drivers = [];
  return parsed;
}

(async () => {
  const startedAt = new Date();
  console.log(`[scan] start ${startedAt.toISOString()} — model ${MODEL}`);
  const ids = Object.keys(LENSES);
  // Run sequentially to stay polite to the free-tier rate limit (requests/min cap).
  const results = {};
  for (const id of ids) {
    try { results[id] = await analyzeLens(id); console.log(`[scan]   ${id}: ok`); }
    catch (e) { results[id] = { error: e.message || "failed" }; console.log(`[scan]   ${id}: ERR ${e.message}`); }
  }

  const out = {
    horizon: "1w",
    generatedAt: startedAt.toISOString(),
    nextRunAt: new Date(startedAt.getTime() + SCAN_INTERVAL_HOURS * 3600 * 1000).toISOString(),
    scanning: false,
    results,
  };
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2));
  const ok = Object.values(results).filter((v) => !v.error).length;
  console.log(`[scan] wrote ${OUTPUT_FILE} — ${ok}/${ids.length} lenses ok`);
  if (ok === 0) process.exit(1); // fail the job if nothing succeeded
})();
