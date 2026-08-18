#!/usr/bin/env node
/**
 * IllumAI v5 — backend
 * ------------------------------------------------------------------
 * Zero-dependency Node server (http only). Serves the SPA (index.html)
 * and a set of JSON APIs:
 *
 *   AUTH / ACCOUNTS
 *     POST /api/register   {username,email,password}
 *     POST /api/login      {email,password}
 *     POST /api/logout     (auth)
 *     GET  /api/me         (auth) full account state
 *     POST /api/sync       (auth) persist vault/history/theme
 *     POST /api/checkin    (auth) daily streak (server-validated)
 *
 *   AI
 *     POST /api/ai         (auth) agent + all 5 tools + chat
 *     POST /api/draft      (auth) Live Source-Anchored Drafts (RAG MVP)
 *
 *   BILLING
 *     POST /api/checkout          (auth) create Stripe Checkout session
 *     POST /api/checkout/confirm  (auth) finalise a purchase (demo or real)
 *
 *   OPS
 *     GET /api/health   ·   GET /api/logs
 *
 * Accounts/sessions/subscriptions/usage are persisted as JSON files under
 * DATA_DIR (default ./data). Passwords are hashed with scrypt — the raw
 * password is never stored. In production, back DATA_DIR with a persistent
 * volume (Render disk, Railway volume, EBS) and consider a real DB.
 *
 * AI keys come ONLY from environment variables (never the browser):
 *   export GLM_API_KEY=...   # GLM 5.2 (OpenAI-compatible)  OR
 *   export ILLUMAI=...       # Cohere fallback
 * If no key is set the server still works using a built-in deterministic
 * demo responder, so the app never fails with "Failed to fetch".
 */
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8787;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

/* ==================================================================
 * Persistent stores
 * ================================================================== */
const USERS_FILE = join(DATA_DIR, "users.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const LOG_FILE = join(DATA_DIR, "document_history.jsonl");

function loadStore(file, fallback) {
  try { if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")); } catch { /* ignore */ }
  return fallback;
}
function saveStore(file, obj) {
  try { writeFileSync(file, JSON.stringify(obj, null, 2), "utf8"); } catch (e) { console.error("[store] write failed:", file, e.message); }
}
const users = loadStore(USERS_FILE, {});
const sessions = loadStore(SESSIONS_FILE, {}); // token -> userId

const rnd = (n) => crypto.randomBytes(n).toString("hex");
const nowStr = () => new Date().toISOString().slice(0, 10);
const dateStr = (ms) => new Date(ms).toISOString().slice(0, 10);
function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; if (d.length > 2e6) { reject(new Error("Payload too large")); req.destroy(); } });
    req.on("end", () => resolve(d));
    req.on("error", reject);
  });
}
function today() { return nowStr(); }
function yesterday() { return dateStr(Date.now() - 864e5); }

/* ==================================================================
 * AI providers (GLM / Cohere) + resilient demo fallback
 * ================================================================== */
const GLM_KEY = process.env.GLM_API_KEY || process.env.ILU_GLM || "";
const COHERE_KEY = process.env.COHERE_API_KEY || process.env.ILLUMAI || process.env.ILU_COHERE || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.ILU_OPENAI || "";
const PROVIDER = (process.env.AI_PROVIDER ||
  (GLM_KEY && COHERE_KEY ? "route" : GLM_KEY ? "glm" : COHERE_KEY ? "cohere" : OPENAI_KEY ? "openai" : "local")).toLowerCase();
const GLM_MODEL = process.env.GLM_MODEL || "glm-5.2";
const GLM_URL = process.env.GLM_API_URL || "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const COHERE_MODEL = process.env.ILLUMAI_MODEL || "command-r-plus-08-2024";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

function isPremiumMode(mode, modelHint) {
  if (/reasoner|premium|deep/i.test(modelHint || "")) return true;
  if (/MODE:\s*(DRAFT|EXPLAIN|ORGANISE)/i.test(mode || "")) return true;
  return /chat|auto/i.test(mode || "");
}

async function callGlm(messages, temperature) {
  if (!GLM_KEY) throw new Error("GLM_API_KEY not configured");
  const r = await fetch(GLM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GLM_KEY}` },
    body: JSON.stringify({ model: GLM_MODEL, messages, temperature, max_tokens: 1000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`GLM ${r.status}: ${t.slice(0, 300)}`); }
  const j = await r.json();
  const out = j?.choices?.[0]?.message?.content || "";
  if (!out) throw new Error("GLM returned an empty response");
  return out.trim();
}
async function callCohere(messages, temperature) {
  if (!COHERE_KEY) throw new Error("Cohere key not configured");
  const content = messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
  const r = await fetch("https://api.cohere.com/v2/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${COHERE_KEY}` },
    body: JSON.stringify({ model: COHERE_MODEL, messages: [{ role: "user", content }], temperature, max_tokens: 1000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`Cohere ${r.status}: ${t.slice(0, 300)}`); }
  const j = await r.json();
  const out = j?.message?.content?.[0]?.text || "";
  if (!out) throw new Error("Cohere returned an empty response");
  return out.trim();
}
async function callOpenAI(messages, temperature) {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not configured");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature, max_tokens: 1000 }),
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`OpenAI ${r.status}: ${t.slice(0, 300)}`); }
  const j = await r.json();
  const out = j?.choices?.[0]?.message?.content || "";
  if (!out) throw new Error("OpenAI returned an empty response");
  return out.trim();
}

function buildMessages({ systemPrompt, userMessage, modePrompt = "", history = [] }) {
  let system = (systemPrompt || "");
  if (modePrompt && !/MODE:/.test(system)) system = `${system}\n\n${modePrompt}`;
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const h of Array.isArray(history) ? history : []) {
    const role = h?.role === "user" ? "user" : "assistant";
    if (h?.content) msgs.push({ role, content: String(h.content) });
  }
  msgs.push({ role: "user", content: String(userMessage || "") });
  return msgs;
}

/* ---- Intent detection: Illumini auto-routes (summarise/explain/rewrite/organise/draft/chat) ---- */
const MODE_PROMPTS = {
  summarise: `MODE: SUMMARISE.\nReturn:\n**Summary** — one tight paragraph.\n**Key takeaways** — 3-6 bullets.\n**Bullet points** — 5-8 skimmable bullets.\nKeep every fact from the source.`,
  explain: `MODE: EXPLAIN.\nExplain so a beginner truly understands. Define jargon, give one memorable analogy, and build up step by step. Sections: introduction, main ideas, examples, conclusion.`,
  rewrite: `MODE: REWRITE.\nRewrite in the requested tone, preserving meaning and all key facts. Improve clarity and flow. Then add a one-line note on what changed.`,
  organise: `MODE: ORGANISE.\nReturn:\n**Task list** — actionable items.\n**Notes** — cleaned & grouped.\n**Study cards** — 3-6 Q&A cards.`,
  draft: `MODE: DRAFT.\nWrite a polished, ready-to-send draft of the requested kind and tone, with a natural greeting and sign-off.`,
};
function detectIntent(text, requestedMode) {
  if (requestedMode && requestedMode !== "auto" && MODE_PROMPTS[requestedMode]) return { mode: requestedMode, prompt: MODE_PROMPTS[requestedMode] };
  const t = " " + String(text || "").toLowerCase() + " ";
  const has = (...ws) => ws.some((w) => t.includes(w));
  if (has("summar", "summary", "condense", "key point", "tl;dr", "short version", "brief me", "gist")) return { mode: "summarise", prompt: MODE_PROMPTS.summarise };
  if (has("rewrite", "rephrase", "improve this", "make it better", "more professional", "polish", "better tone", "reword", "fix grammar", "cleaner")) return { mode: "rewrite", prompt: MODE_PROMPTS.rewrite };
  if (has("organis", "structure", "outline", "turn into a list", "study card", "action items", "task list", "clean up my notes")) return { mode: "organise", prompt: MODE_PROMPTS.organise };
  if (has("draft an email", "draft a ", "write me ", "write a ", "compose", "create a post", "write an essay", "write a script", "draft a message")) return { mode: "draft", prompt: MODE_PROMPTS.draft };
  if (has("explain", "what is ", "what does ", "how does ", "why does ", "understand", "simple terms", "clarif", "breakdown", "beginner")) return { mode: "explain", prompt: MODE_PROMPTS.explain };
  return { mode: "chat", prompt: "" };
}
function providerFor(mode) {
  if (mode === "explain" || mode === "draft") return "glm";
  if (mode === "summarise" || mode === "rewrite" || mode === "organise") return "cohere";
  return "openai";
}
function localRespond(messages) {
  const user = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const system = messages.find((m) => m.role === "system")?.content || "";
  const mode = (system.match(/MODE:\s*(\w+)/i) || [])[1] || "agent";
  const snip = String(user).slice(0, 240);
  if (mode === "DRAFT") return `Here is your polished draft based on your brief:\n\n"${snip}"\n\n◆ Opening — set the context and the outcome you want.\n◆ Body — a clear, friendly explanation, one idea per short paragraph.\n◆ Call to action — the single next step for the reader.\n\n(⚙ Demo mode: connect GLM_API_KEY, ILLUMAI, or OPENAI_API_KEY for rich, fluent drafts.)`;
  return `Here is Illumini's clarity output for: "${snip}"\n\n**Key takeaways**\n• We handled this as a "${mode}" task.\n• Every key fact from the source is preserved.\n• Use Copy to save it, or Save to Vault to keep it forever.\n\n(⚙ Demo responder active — set GLM_API_KEY, ILLUMAI, or OPENAI_API_KEY for live AI.)`;
}

const PROVIDERS = { glm: GLM_KEY, cohere: COHERE_KEY, openai: OPENAI_KEY };
function orderFor(mode) {
  if (PROVIDER === "glm") return ["glm"];
  if (PROVIDER === "cohere") return ["cohere"];
  if (PROVIDER === "openai") return ["openai"];
  const avail = Object.keys(PROVIDERS).filter((p) => PROVIDERS[p]);
  const pref = providerFor(mode);
  const order = [pref, ...avail.filter((p) => p !== pref)];
  if (avail.includes("cohere")) order.unshift("cohere"); // reliable key first = faster responses
  return [...new Set(order)];
}
// Ask the model to reason first, then answer — so Illumini can show its thought process.
const THINK_GUIDE = `IMPORTANT OUTPUT FORMAT: show your reasoning BEFORE the final answer.
FIRST, write the single line "THINKING:" followed by 3-5 short bullet points of your reasoning, plan and what you will include (keep it under ~120 words).
THEN, on a new line write "ANSWER:" and give your complete, polished final answer.
Never repeat the THINKING content inside the ANSWER. The ANSWER is what the user reads.`;
function splitReason(raw) {
  const s = String(raw || "").trim();
  const idx = s.indexOf("ANSWER:");
  if (idx >= 0) {
    const th = s.slice(0, idx).replace(/^THINKING\s*:/i, "").trim();
    return { thinking: th, result: s.slice(idx + 7).trim() };
  }
  return { thinking: "", result: s };
}
async function runAI({ systemPrompt, userText, modePrompt = "", model = "", history = [], mode = "" }) {
  let effMode, effPrompt;
  if (modePrompt && /MODE:\s*(\w+)/.test(modePrompt)) { effMode = modePrompt.match(/MODE:\s*(\w+)/i)[1].toLowerCase(); effPrompt = modePrompt; }
  else { const d = detectIntent(userText, mode); effMode = d.mode; effPrompt = d.prompt; }
  const premium = isPremiumMode(effPrompt + " " + effMode, model);
  const sys = `${systemPrompt || ""}\n\n${THINK_GUIDE}`;
  const messages = buildMessages({ systemPrompt: sys, userMessage: userText, modePrompt: effPrompt, history });
  const temp = premium ? 0.5 : 0.3;
  const callers = {
    glm: () => callGlm(messages, temp).then((result) => ({ provider: "glm", model: GLM_MODEL, result })),
    cohere: () => callCohere(messages, temp).then((result) => ({ provider: "cohere", model: COHERE_MODEL, result })),
    openai: () => callOpenAI(messages, temp).then((result) => ({ provider: "openai", model: OPENAI_MODEL, result })),
  };
  let lastErr;
  for (const p of orderFor(effMode)) {
    try {
      const out = await callers[p]();
      const { thinking, result } = splitReason(out.result);
      return { mode: effMode, provider: out.provider, model: out.model, result, thinking };
    } catch (e) { lastErr = e; console.warn("[ai]", p, "failed, trying next:", e.message); }
  }
  const demo = localRespond(messages);
  return { mode: effMode, provider: "local", model: "demo", result: demo, thinking: "No live AI key is configured, so I'm using the built-in demo responder. Add GLM_API_KEY, ILLUMA (Cohere) or OPENAI_API_KEY to enable real reasoning." };
}

/* ==================================================================
 * Plans, limits & streak (server-authoritative)
 * ================================================================== */
// Owner accounts (the creator) always hold the top plan + every pack, auto-granted.
const OWNER_EMAILS = ["usimere@gmail.com", "usimijere@gmail.com", "ijereusim@gmail.com"];
const OWNER_USERNAMES = ["uchimij", "usimijere", "usimere", "jere"];
const normId = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const isOwnerId = (s) => { const n = normId(s); return OWNER_EMAILS.some(e => normId(e) === n) || OWNER_USERNAMES.some(u => normId(u) === n); };
function grantOwner(u) {
  u.owner = true;
  u.plan = "proultraplus";
  u.credits = 1e9;
  u.subscription = { status: "active", plan: "proultraplus", cycle: "m", started: Date.now(), renew: Date.now() + 31536000000 };
  u.usage = { cycleStart: Date.now(), cycleEnd: Date.now() + 31536000000, used: 0 };
  return u;
}

const PLAN_PRICES = {
  pro:          { name: "Pro",        m: 5.99,  y: 49.99 },
  proplus:      { name: "Pro+",       m: 12.99, y: 109.99 },
  proultra:     { name: "Pro Ultra",  m: 29.99, y: 239 },
  proultraplus: { name: "Pro Ultra+", m: 49.99, y: 399 },
};
const PLAN_CAP = { pro: 200, proplus: 650, proultra: 2500, proultraplus: Infinity };
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || "";
const CURRENCY = (process.env.ILLUMAI_CURRENCY || "gbp").toLowerCase();

function newAccount(username, email, password) {
  const salt = rnd(16);
  return {
    id: rnd(8),
    username,
    email: String(email).toLowerCase(),
    salt,
    pass: hashPassword(password, salt),
    plan: "free",
    created: Date.now(),
    credits: 5,
    streak: { count: 0, lastDate: null },
    usage: { cycleStart: null, cycleEnd: null, used: 0 },
    usedTotal: 0,
    subscription: null,
    purchases: [],
    vault: [],
    history: [],
    theme: "light",
  };
}
function isPaid(u) { return u.plan !== "free"; }

function refreshUsage(u) {
  const sub = u.subscription;
  if (!sub || sub.plan !== u.plan || !sub.renew) { u.usage = { cycleStart: null, cycleEnd: null, used: 0 }; return; }
  const now = Date.now();
  if (!u.usage?.cycleEnd || now >= u.usage.cycleEnd) {
    u.usage = { cycleStart: sub.started, cycleEnd: sub.renew, used: 0 };
  }
}
function remaining(u) {
  if (u.plan === "free") return u.credits;
  refreshUsage(u);
  const cap = PLAN_CAP[u.plan];
  if (cap === Infinity) return Infinity;
  return Math.max(0, cap - (u.usage?.used || 0));
}
function consume(u) {
  u.usedTotal = (u.usedTotal || 0) + 1;
  if (u.plan === "free") u.credits = Math.max(0, (u.credits || 0) - 1);
  else { refreshUsage(u); u.usage.used = (u.usage?.used || 0) + 1; }
}

function streakTier(count) {
  if (count >= 100) return { name: "Frenzy", next: null };
  if (count >= 25) return { name: "Blue", next: { at: 100, n: "Frenzy Flame" } };
  if (count >= 10) return { name: "Purple", next: { at: 25, n: "Blue Flame" } };
  if (count >= 5) return { name: "Red", next: { at: 10, n: "Purple Flame" } };
  return { name: "Orange", next: { at: 5, n: "Red Flame" } };
}
function tickStreak(u) {
  const t = today();
  const y = yesterday();
  const s = u.streak || { count: 0, lastDate: null };
  if (s.lastDate === t) return s;
  u.streak = { count: s.lastDate === y ? (s.count || 0) + 1 : 1, lastDate: t };
  return u.streak;
}

function publicUser(u) {
  refreshUsage(u);
  const sub = u.subscription;
  const subActive = sub && sub.status === "active" && Date.now() < (sub.renew || 0);
  // JSON cannot carry Infinity, so encode it as the string "unlimited".
  const enc = (v) => (v === Infinity ? "unlimited" : v);
  return {
    id: u.id, username: u.username, email: u.email,
    owner: !!u.owner,
    plan: u.plan, planName: PLAN_PRICES[u.plan]?.name || "Free",
    credits: u.plan === "free" ? u.credits : "unlimited",
    used: u.usedTotal,
    streak: u.streak,
    tier: streakTier(u.streak?.count || 0),
    limit: u.plan === "free" ? null : { cap: enc(PLAN_CAP[u.plan]), used: u.usage?.used || 0, remaining: enc(remaining(u)) },
    subscription: subActive ? {
      plan: sub.plan, cycle: sub.cycle, started: sub.started, renew: sub.renew, active: true,
    } : null,
    purchases: u.purchases || [],
    vault: u.vault || [],
    history: u.history || [],
    theme: u.theme || "light",
    created: u.created,
  };
}

/* ==================================================================
 * RAG — Live Source-Anchored Drafts (MVP)
 * ------------------------------------------------------------------
 * Retrieval: keyword scoring over a small built-in knowledge corpus.
 * In production, replace retrieve() with a search API (SerpAPI/Google
 * CSE/Bing) or a vector DB — the anchoring pipeline is unchanged.
 * ================================================================== */
const CORPUS = [
  { id: 1, title: "The Science of Sleep and Circadian Rhythms", url: "https://example.com/science/sleep", cred: 0.92, snippet: "Circadian rhythms are internal cycles of roughly 24 hours that govern sleep-wake timing; morning light shifts the clock earlier and improves alertness." },
  { id: 2, title: "Economics: Supply, Demand & Inflation", url: "https://example.com/econ/supply-demand", cred: 0.90, snippet: "Inflation measures the general rise in prices; central banks raise interest rates to cool demand when inflation is above target." },
  { id: 3, title: "Foundations of Machine Learning", url: "https://example.com/ai/ml-foundations", cred: 0.93, snippet: "Supervised learning fits a function from labelled examples; the model generalises to unseen inputs by minimising prediction error." },
  { id: 4, title: "Climate Change & Net Zero", url: "https://example.com/climate/net-zero", cred: 0.91, snippet: "Net zero means balancing emitted and removed greenhouse gases; the IPCC stresses rapid cuts this decade to hold warming near 1.5\u00b0C." },
  { id: 5, title: "Nutrition and Balanced Diets", url: "https://example.com/health/nutrition", cred: 0.89, snippet: "A balanced diet provides carbohydrates, protein, fats, vitamins and fibre; whole foods generally support metabolic health better than ultra-processed ones." },
  { id: 6, title: "Startups, Pricing & Unit Economics", url: "https://example.com/business/unit-econ", cred: 0.88, snippet: "Unit economics evaluate revenue and cost per customer; healthy SaaS firms keep customer-acquisition cost well below lifetime value." },
];
function retrieve(query, n = 4) {
  const q = String(query).toLowerCase();
  const scored = CORPUS.map((s) => {
    const pool = (s.title + " " + s.snippet).toLowerCase();
    let score = 0;
    for (const term of q.split(/[^a-z0-9]+/)) if (term.length > 2 && pool.includes(term)) score++;
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, n).map((x) => x.s);
  return picked.length ? picked : CORPUS.slice(0, n);
}

async function anchoredDraft(user, userText) {
  const sources = retrieve(userText, 4);
  const srcBlob = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.snippet}`).join("\n");
  const prompt =
    `Write a polished, well-structured draft on the topic below.\n` +
    `Use the provided sources as the factual basis where relevant.\n` +
    `Mark EVERY sentence with a confidence tag immediately after it:\n` +
    `  [S] = sourced from a provided reference (attach its number like (src 2))\n` +
    `  [I] = inferred from the sources but not stated directly\n` +
    `  [C] = creative framing, transitions or voice\n` +
    `SOURCE INDEX:\n${srcBlob}\n\nTOPIC:\n${userText}\n\nDraft:`;
  const sys = "You are a careful research writer. Never invent citations; only anchor to the provided sources.";
  const hasKeys = !!(GLM_KEY || COHERE_KEY);
  let draft = null;
  if (hasKeys) {
    try { draft = (await runAI({ systemPrompt: sys, userText: prompt })).result; } catch (e) { draft = null; }
  }
  if (!draft) {
    // Built-in anchored demo draft — keeps the flagship feature working with no keys.
    const t1 = sources[0], t2 = sources[1];
    const topic = String(userText).slice(0, 70);
    draft =
      `**${topic}** — a grounded briefing\n\n` +
      `The core mechanics of this topic are well documented in the literature. [S] (src 1)\n` +
      (t2 ? `Independent research points to consistent, measurable effects across populations. [S] (src 2)\n` : ``) +
      `Taken together, the evidence implies the practical steps outlined below. [I]\n` +
      `In short: the most balanced approach is an evidence-led, steady one. [C]\n\n` +
      `(⚙ Demo grounding — connect GLM_API_KEY for fully fluent anchored prose.)`;
  }
  return { draft, sources, maxAnchors: user.plan === "free" ? 2 : Infinity };
}

/* ==================================================================
 * History (JSONL)
 * ================================================================== */
let history = [];
if (existsSync(LOG_FILE)) {
  try {
    history = readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { history = []; }
}
function logRow(entry) {
  const row = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: new Date().toISOString(), ...entry };
  history.push(row); if (history.length > 5000) history = history.slice(-5000);
  try { appendFileSync(LOG_FILE, JSON.stringify(row) + "\n", "utf8"); } catch { /* ignore */ }
}

/* ==================================================================
 * Server
 * ================================================================== */
const indexHtml = readFileSync(join(__dirname, "index.html"), "utf8");

function getAuthUser(req) {
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  return sessions[tok] ? users[sessions[tok]] : null;
}
function originUrl(req) { return req.headers.origin || `http://localhost:${PORT}`; }
function persist() { saveStore(USERS_FILE, users); saveStore(SESSIONS_FILE, sessions); }

const server = http.createServer(async (req, res) => {
  // CORS — lets a separately-hosted SPA talk to this API.
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const P = url.pathname;
  const u = getAuthUser(req);

  if (P === "/api/health") {
    return json(res, 200, { ok: true, provider: PROVIDER, keyConfigured: !!(GLM_KEY || COHERE_KEY || OPENAI_KEY), glm: !!GLM_KEY, cohere: !!COHERE_KEY, openai: !!OPENAI_KEY, stripe: !!STRIPE_KEY, currency: CURRENCY, users: Object.keys(users).length, dbRows: history.length });
  }

  /* ---------- Auth ---------- */
  if (P === "/api/register" && req.method === "POST") {
    try {
      const { username, email, password } = JSON.parse(await readBody(req));
      const e = String(email || "").toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(e)) throw new Error("Please enter a valid email address.");
      if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters.");
      if (users[e]) throw new Error("An account with that email already exists. Try signing in.");
      const acct = newAccount(String(username || "").trim() || e.split("@")[0], e, password);
      if (OWNER_EMAILS.includes(e)) grantOwner(acct);
      users[e] = acct;
      const tok = rnd(32); sessions[tok] = e;
      persist(); logRow({ action: "register", input: e });
      return json(res, 200, { ok: true, token: tok, user: publicUser(acct) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (P === "/api/login" && req.method === "POST") {
    try {
      const { email, username, password } = JSON.parse(await readBody(req));
      const ident = String(email || username || "").toLowerCase();
      let acct = users[ident];
      if (!acct) { // allow login by username too
        for (const k in users) { if (users[k].username && String(users[k].username).toLowerCase() === ident) { acct = users[k]; break; } }
      }
      if (!acct && isOwnerId(ident)) { // owner always gets in, even after a wipe or with a different identifier
        acct = newAccount(ident.split("@")[0], ident, password);
        grantOwner(acct);
        users[ident] = acct;
      }
      if (!acct) throw new Error("No account found with that email or username. Sign up to create one.");
      if (hashPassword(String(password || ""), acct.salt) !== acct.pass) throw new Error("Incorrect password.");
      if (OWNER_EMAILS.includes(acct.email) && !acct.owner) grantOwner(acct);
      const tok = rnd(32); sessions[tok] = acct.email;
      persist();
      return json(res, 200, { ok: true, token: tok, user: publicUser(acct) });
    } catch (e) { return json(res, 401, { ok: false, error: e.message }); }
  }
  if (P === "/api/logout" && req.method === "POST") {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
    delete sessions[tok]; saveStore(SESSIONS_FILE, sessions);
    return json(res, 200, { ok: true });
  }

  /* ---------- Account ---------- */
  if (P === "/api/me" && req.method === "GET") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    return json(res, 200, { ok: true, user: publicUser(u) });
  }
  if (P === "/api/sync" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    try {
      const b = JSON.parse(await readBody(req));
      if (Array.isArray(b.vault)) u.vault = b.vault.slice(0, 300);
      if (Array.isArray(b.history)) u.history = b.history.slice(0, 200);
      if (b.theme) u.theme = b.theme;
      saveStore(USERS_FILE, users);
      return json(res, 200, { ok: true, user: publicUser(u) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }
  if (P === "/api/checkin" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    const s = tickStreak(u); saveStore(USERS_FILE, users);
    return json(res, 200, { ok: true, streak: s, tier: streakTier(s.count) });
  }

  /* ---------- AI ---------- */
  if (P === "/api/ai" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    try {
      const { systemPrompt, userText, modePrompt, model, history, mode } = JSON.parse(await readBody(req));
      if (!userText || !String(userText).trim()) throw new Error("No input text provided.");
      if (u.plan === "free" && (u.credits || 0) <= 0)
        return json(res, 402, { ok: false, error: "You're out of illuminations. Top up or upgrade.", code: "NO_CREDITS" });
      refreshUsage(u);
      if (u.plan !== "free") {
        const cap = PLAN_CAP[u.plan];
        if (cap !== Infinity && (u.usage?.used || 0) >= cap)
          return json(res, 402, { ok: false, error: `You've used all ${cap} illuminations for this billing cycle. It resets at renewal.`, code: "LIMIT" });
      }
      consume(u); tickStreak(u); saveStore(USERS_FILE, users);
      const { provider, model: usedModel, result, thinking, mode: effMode } = await runAI({ systemPrompt, userText, modePrompt, model, history, mode });
      logRow({ action: "illumination", input: userText, output: result, meta: { provider, model: usedModel, user: u.email, mode: effMode } });
      return json(res, 200, { ok: true, result, thinking, provider, mode: effMode, user: publicUser(u) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  /* ---------- Source-Anchored Drafts (Pro) ---------- */
  if (P === "/api/draft" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    try {
      const { text } = JSON.parse(await readBody(req));
      if (!text || !String(text).trim()) throw new Error("Please provide a topic or paste some text.");
      if (u.plan === "free")
        return json(res, 402, { ok: false, error: "Live Source-Anchored Drafts are a Pro feature. Upgrade to unlock full anchoring.", code: "PRO_FEATURE" });
      const { draft, sources, maxAnchors } = await anchoredDraft(u, text);
      consume(u); saveStore(USERS_FILE, users);
      logRow({ action: "draft", input: text, output: draft, meta: { user: u.email } });
      return json(res, 200, { ok: true, draft, sources, maxAnchors, user: publicUser(u) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  /* ---------- Checkout ---------- */
  if (P === "/api/checkout" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    try {
      const { plan, pack, cycle = "m", method = "card" } = JSON.parse(await readBody(req));
      const isPack = !!pack;
      const label = isPack ? `${Number(pack) * 10} illuminations` : `IllumAI ${PLAN_PRICES[plan]?.name || plan} (${cycle === "y" ? "annual" : "monthly"})`;
      if (isPack && u.plan !== "free") throw new Error("Credit packs are only for Free accounts.");
      if (!isPack) {
        if (!PLAN_PRICES[plan]) throw new Error("Unknown plan: " + plan);
        if (u.subscription && u.subscription.plan === plan && Date.now() < (u.subscription.renew || 0))
          throw new Error(`You already own ${PLAN_PRICES[plan].name}. It stays active until it renews or expires.`);
      }
      if (!STRIPE_KEY)
        return json(res, 200, { ok: true, demo: true, label, plan, pack, cycle });
      const amountPence = isPack ? Math.round(99 * Number(pack)) : Math.round((cycle === "y" ? PLAN_PRICES[plan].y : PLAN_PRICES[plan].m) * 100);
      const f = new URLSearchParams();
      f.append("mode", isPack ? "payment" : "subscription");
      f.append("success_url", originUrl(req) + "#/profile?paid=1&session={CHECKOUT_SESSION_ID}");
      f.append("cancel_url", originUrl(req) + "#/plans");
      if (u.email) f.append("customer_email", u.email);
      f.append("payment_method_types[0]", "card");
      if (isPack && method === "paypal") f.append("payment_method_types[1]", "paypal");
      f.append("line_items[0][quantity]", "1");
      f.append("line_items[0][price_data][currency]", CURRENCY);
      f.append("line_items[0][price_data][product_data][name]", label);
      f.append("line_items[0][price_data][unit_amount]", String(amountPence));
      if (!isPack) f.append("line_items[0][price_data][recurring][interval]", cycle === "y" ? "year" : "month");
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: f.toString(),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message || "Stripe " + r.status);
      logRow({ action: "checkout", input: label, output: j.id, meta: { user: u.email } });
      return json(res, 200, { ok: true, url: j.url, id: j.id, demo: false, plan, pack, cycle });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  if (P === "/api/checkout/confirm" && req.method === "POST") {
    if (!u) return json(res, 401, { ok: false, error: "Not signed in" });
    try {
      const { plan, pack, cycle = "m", demo = true } = JSON.parse(await readBody(req));
      if (pack) {
        if (u.plan !== "free") throw new Error("Credit packs are for Free plans only.");
        u.credits = (u.credits || 0) + Number(pack) * 10;
      } else if (plan === "free") {
        // Downgrade to Free — keep vault/history, reset credits to the trial balance.
        u.plan = "free"; u.subscription = null;
        u.usage = { cycleStart: null, cycleEnd: null, used: 0 };
        u.credits = Math.max(u.credits || 0, 5);
      } else {
        if (!PLAN_PRICES[plan]) throw new Error("Unknown plan: " + plan);
        if (u.subscription && u.subscription.plan === plan && Date.now() < (u.subscription.renew || 0))
          throw new Error("You already own this plan and it's still active.");
        const ms = cycle === "y" ? 365 * 864e5 : 30 * 864e5;
        u.plan = plan;
        u.subscription = { plan, cycle, status: "active", started: Date.now(), renew: Date.now() + ms };
        u.usage = { cycleStart: Date.now(), cycleEnd: Date.now() + ms, used: 0 };
        u.purchases = (u.purchases || []).concat({ plan, cycle, at: Date.now(), amount: cycle === "y" ? PLAN_PRICES[plan].y : PLAN_PRICES[plan].m, currency: CURRENCY, method: demo ? "demo" : "stripe" });
      }
      saveStore(USERS_FILE, users);
      return json(res, 200, { ok: true, user: publicUser(u) });
    } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  }

  /* ---------- Logs / SPA ---------- */
  if (P === "/api/logs" && req.method === "GET") {
    const limit = Number(url.searchParams.get("limit") || 50);
    return json(res, 200, { ok: true, logs: history.slice(-Math.max(1, limit)).reverse(), count: history.length });
  }
  if (P === "/" || P === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(indexHtml);
  }
  return json(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`\n  ✨ IllumAI v5 running → http://localhost:${PORT}`);
  console.log(`  AI provider: ${PROVIDER}  |  key ${(GLM_KEY || COHERE_KEY || OPENAI_KEY) ? "configured ✓" : "demo mode (set GLM_API_KEY, ILLUMAI, or OPENAI_API_KEY)"}`);
  console.log(`  Models — GLM: ${GLM_KEY ? GLM_MODEL : "—"} · Cohere: ${COHERE_KEY ? COHERE_MODEL : "—"} · OpenAI: ${OPENAI_KEY ? OPENAI_MODEL : "—"}`);
  console.log(`  Accounts: ${Object.keys(users).length}  |  data → ${DATA_DIR}`);
});