# IllumAI v5 ✨ — Illuminate your understanding

A premium, single-page AI writing app with a glowing orb agent (**Illumini**), 5 clarity tools, the
flagship **Live Source-Anchored Drafts** (RAG), an **AI Humanizer** tab (coming soon), daily streaks,
real **accounts**, **subscription limits**, **re-purchase prevention**, and a full
Free → Pro → Pro+ → Pro Ultra → Pro Ultra+ monetisation stack.

---

## What's new in v5 (this build)

| # | Feature | Where |
|---|---------|-------|
| 1 | **AI agent fixed.** Same-origin `/api/ai`, CORS headers, resilient provider routing, a friendly error instead of raw "Failed to fetch", and a **built-in demo responder** so it never breaks with no keys. | `server.js` + `index.html` |
| 2 | **Cleaner streak icon + continuous gentle tilt** (left ↔ right, `prefers-reduced-motion` respected). | `index.html` |
|   | **Login / Sign-up button (top-left), forced on arrival**, with a full **server-side account** that saves streak, Vault, usage, **and purchases**. | `server.js` + `index.html` |
| 3 | **Streak rewards corrected.** Tiers orange·0 / red·5 / purple·10 / blue·25 / **Frenzy·100**, enforced **server-side** (Frenzy can no longer trigger on day 2). | `server.js` |
| 4 | **Subscription limits per plan** (Pro 200 · Pro+ 650 · Pro Ultra 2500 · Pro Ultra+ unlimited) per billing cycle, with a remaining counter shown in the UI, hard lock-out at the cap, and auto-reset at renewal. | `server.js` + `index.html` |
| 5 | **Re-purchase prevention.** Owned/active plans are disabled and show a renewal date; purchases re-enable only after expiry. | `server.js` + `index.html` |
| 6 | **Top-right branding.** Clean "IllumAI" wordmark + minimal aperture logo, visible in light & dark mode. | `index.html` |
| 7 | **AI Humanizer tab** in the sidebar → "Coming Soon." | `index.html` |
| — | **AI Chatbot (Pro Ultra+)** → "Run all your work in one place, freely" + **AI chatbot coming soon**; OpenAI provider wired in. | `server.js` + `index.html` |
| 8 | **Live Source-Anchored Drafts** (Pro). Inline confidence tags (✔︎ Sourced / ~ Inferred / ✶ Creative), clickable anchors → citation cards (title, snippet, credibility bar, **Quick Verify**). Free users get limited anchors; Pro+ get full. | `server.js` (RAG) + `index.html` |
| 9 | **Deployable package** — Dockerfile, Render blueprint, Procfile, and run/deploy instructions below. | this folder |

---

## Run it

```bash
# Option A — GLM 5.2 (recommended): key at https://open.bigmodel.cn
export GLM_API_KEY=sk-...

# Option B — Cohere fallback
export ILLUMAI=your_cohere_key

# (Optional) real payments
export STRIPE_SECRET_KEY=sk_live_...
export ILLUMAI_CURRENCY=gbp

node server.js
```

Then open **http://localhost:8787**.

> With **no** AI key set, the app runs in **demo mode** (built-in responder) so the AI agent and
> Source-Anchored Drafts still work end-to-end — nothing ever shows "Failed to fetch".

| Env var | Purpose |
|---|---|
| `GLM_API_KEY` | GLM 5.2 key (auto-selects `glm` provider) |
| `ILLUMAI` (or `COHERE_API_KEY`) | Cohere fallback key |
| `AI_PROVIDER` | `route` (default) · `glm` · `cohere` · `both` · `local` |
| `STRIPE_SECRET_KEY` | Enables real Stripe Checkout (card / Apple Pay / PayPal) |
| `ILLUMAI_CURRENCY` | `gbp` (default), `usd`, `eur`, … |
| `PORT` | HTTP port (default `8787`) |
| `DATA` | Persistent storage dir (default `./data`) |

---

## API

- `POST /api/register` · `POST /api/login` · `POST /api/logout` — accounts (scrypt-hashed passwords)
- `GET /api/me` · `POST /api/sync` · `POST /api/checkin` — account state, sync, streak
- `POST /api/ai` — `{systemPrompt,userText,modePrompt,model,history}` → `{ok,result,user}` (agent + all tools + chat)
- `POST /api/draft` — `{text}` → `{ok,draft,sources,maxAnchors,user}` (RAG, Pro-gated)
- `POST /api/checkout` · `POST /api/checkout/confirm` — Stripe Checkout + finalisation (demo or real)
- `GET /api/health` · `GET /api/logs`

---

## Deploy

**Render (recommended, one click):** push this folder to a repo, then either use `render.yaml`
(Blueprint) or a new **Web Service** → Runtime *Node* → Start command `node server.js` → add a
**Persistent Disk** mounted at `/data` (1 GB). Add `GLM_API_KEY`, `STRIPE_SECRET_KEY` as secrets.

**Railway / Fly.io / VPS:** `docker build -t illumai . && docker run -p 8787:8787 -v illumai-data:/data illumai` — then set the env vars and point your domain at it.

**Domain + SSL:** point your domain's DNS (A/AAAA or CNAME) at the host, enable SSL (automatic on
Render/Railway, or Let's Encrypt / Caddy on a VPS), and set your custom domain in the host dashboard.

> **Storage note:** accounts, sessions, subscriptions, usage and purchase history are persisted as JSON
> files under `/data`. Keep `/data` on a **persistent volume** so nothing is lost on restart. For very
> high scale, move the store to a real database — the API surface already matches that migration.

## AI & Source retrieval

- AI is routed: quick jobs (summarise/rewrite) → fast model; deep jobs (draft/explain/organise) → premium.
- **Source-Anchored Drafts** currently retrieve from a built-in knowledge corpus (keyword scoring).
  To use real web sources, replace `retrieve()` in `server.js` with a search-API call
  (SerpAPI / Google CSE / Bing / your vector DB) — the anchoring + UI pipeline is unchanged.