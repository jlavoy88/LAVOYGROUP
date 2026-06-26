// ===========================================================================
// MORNING PREP — one-shot gold trading-prep brief for GitHub Actions
// (Gemini / free-tier edition). Produces a concise morning briefing the
// homepage "Morning Prep" panel reads. No server required.
//
//   GEMINI_API_KEY=...  node prep.mjs
//   OUTPUT_FILE=data/prep.json (default)
//   GEMINI_MODEL=gemini-2.5-flash (default; any free-tier Flash works)
//
// Uses Google's Gemini API with Grounding (google_search) for live news.
// ONE grounded call returns the whole brief, with an offline strict-JSON
// fallback so the job still produces something if grounding hiccups.
// ===========================================================================

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "data/prep.json";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

if (!API_KEY) { console.error("Missing GEMINI_API_KEY"); process.exit(1); }

const todayISO = new Date().toISOString().slice(0, 10);

function buildPrompt(useSearch) {
  const dataLine = useSearch
    ? "Research CURRENT conditions and the very latest news using Google Search before answering. Use real, current data and real headlines you find; do not invent figures, sources, or quotes."
    : "You do NOT have live data access right now. Reason from your general knowledge of recent conditions; keep statements general, do NOT fabricate specific live figures or headlines, and prefer empty arrays over invented content.";

  return `You are a gold-focused futures trader writing your own concise pre-market prep brief for ${todayISO}. Your sole instrument is gold (XAU/USD spot and COMEX GC futures). Everything you report must be framed by how it matters for GOLD. ${dataLine}

Cover ONLY what actually moves gold right now: real (TIPS) yields, the US dollar (DXY), Fed policy / rate-path expectations, safe-haven & geopolitical risk, key US macro data on today's calendar, and central-bank / physical demand.

Produce a tight morning briefing. Be specific and calibrated; if something is unclear, say so briefly rather than overstating.

Respond with ONLY a JSON object — no prose, no code fences — matching exactly this shape:
{
  "asOf": "${todayISO}",
  "riskTone": { "lean": "Risk-off | Risk-on | Mixed", "note": "<=130 chars: one-line read of the session's risk tone and what it means for gold" },
  "overnight": "<=300 chars: what moved in the Asia/Europe overnight sessions and why, focused on gold and its drivers",
  "sectorDrivers": "<=300 chars: what is driving gold / precious metals right now (yields, dollar, Fed, haven flows, demand)",
  "keyEvents": [
    { "time": "08:30 ET", "event": "<short event/data release name>", "impact": "High | Med | Low", "note": "<=70 chars: why it matters for gold" }
  ],
  "headlines": [
    { "headline": "<the actual headline>", "source": "<publication, e.g. Reuters>", "note": "<=80 chars: why it matters for gold" }
  ]
}

Rules: keyEvents = today's scheduled, gold-relevant economic/central-bank events ONLY (0 to 4 items; empty array if none today). headlines = EXACTLY the 3 most important, most recent news items relevant to gold, newest/most market-moving first. Output JSON only.`;
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
  try { return JSON.parse(t); } catch (_) { /* fall through to repair */ }
  const r = t
    .replace(/[\u0000-\u001F]+/g, " ")  // control chars / raw line breaks -> space
    .replace(/,\s*([}\]])/g, "$1");       // trailing commas before } or ]
  return JSON.parse(r);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(useSearch) {
  const body = {
    contents: [{ role: "user", parts: [{ text: buildPrompt(useSearch) }] }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4000 },
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  } else {
    body.generationConfig.responseMimeType = "application/json";
  }

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
      const text = combineText(data);
      if (!text.trim()) {
        const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "no text";
        throw new Error(`no text out (finish=${reason})`);
      }
      return text;
    }
    let msg = `HTTP ${res.status}`;
    try { const e = JSON.parse(rawText); if (e?.error?.message) msg = `HTTP ${res.status} — ${e.error.message}`; }
    catch (_) { if (rawText) msg = `HTTP ${res.status} — ${rawText.slice(0, 160)}`; }
    lastErr = msg;
    const transient = res.status === 429 || res.status === 500 || res.status === 503;
    if (transient && attempt < MAX_TRIES) { await sleep(attempt * 5000); continue; }
    throw new Error(msg);
  }
  throw new Error(lastErr);
}

function clampStr(v, n) { return typeof v === "string" ? v.slice(0, n) : ""; }

function normalize(parsed, live) {
  const out = {
    asOf: clampStr(parsed.asOf, 10) || todayISO,
    live,
    riskTone: {
      lean: clampStr(parsed?.riskTone?.lean, 24) || "Mixed",
      note: clampStr(parsed?.riskTone?.note, 160),
    },
    overnight: clampStr(parsed.overnight, 400),
    sectorDrivers: clampStr(parsed.sectorDrivers, 400),
    keyEvents: Array.isArray(parsed.keyEvents) ? parsed.keyEvents.slice(0, 4).map((e) => ({
      time: clampStr(e.time, 20),
      event: clampStr(e.event, 90),
      impact: clampStr(e.impact, 8) || "Med",
      note: clampStr(e.note, 100),
    })) : [],
    headlines: Array.isArray(parsed.headlines) ? parsed.headlines.slice(0, 3).map((h) => ({
      headline: clampStr(h.headline, 200),
      source: clampStr(h.source, 50),
      note: clampStr(h.note, 110),
    })) : [],
  };
  return out;
}

(async () => {
  const startedAt = new Date();
  console.log(`[prep] start ${startedAt.toISOString()} — model ${MODEL}`);

  let parsed = null, live = true; const log = [];
  try { const t = await callGemini(true); try { parsed = extractJSON(t); } catch (pe) { log.push(`live-parse: ${pe.message}`); } }
  catch (e) { log.push(`live: ${e.message}`); }
  if (!parsed) {
    live = false;
    try { const t2 = await callGemini(false); try { parsed = extractJSON(t2); } catch (pe) { log.push(`offline-parse: ${pe.message}`); } }
    catch (e2) { log.push(`offline: ${e2.message}`); }
  }

  let out;
  if (!parsed) {
    console.error(`[prep] FAILED — ${log.join("  |  ")}`);
    out = { generatedAt: startedAt.toISOString(), error: log.join("  |  ") };
    await mkdir(dirname(OUTPUT_FILE), { recursive: true });
    await writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2));
    process.exit(1);
  }

  out = { generatedAt: startedAt.toISOString(), ...normalize(parsed, live) };
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(out, null, 2));
  console.log(`[prep] wrote ${OUTPUT_FILE} — ${out.headlines.length} headlines, ${out.keyEvents.length} events, live=${live}`);
})();
