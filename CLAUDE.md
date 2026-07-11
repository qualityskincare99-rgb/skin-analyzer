# CLAUDE.md — Quality SkinCare AI Skin Analyzer

Project context for Claude Code. Read this before touching anything.

---

## What this is

The AI brain behind an **existing** skin analyzer UI on the Quality SkinCare Shopify store.
The camera page and front-end already exist. **Do not redesign or rebuild the UI.**

We are building the backend intelligence: computer-vision adapter, confidence routing,
dynamic question engine, weighted recommendation engine, explainability, safety gating,
persistence, and Shopify integration.

Brand: Quality SkinCare — "Dermatologist Formulated. Naturally Radiant."
Market: Karachi, Pakistan. Customers are predominantly **Fitzpatrick IV–VI**.

---

## Non-negotiable rules

### 1. The two medical SKUs are hard-gated
`Scabies Treatment Soap` (QSC-STS) and `Anti Fungal Soap` (QSC-AFS) treat a parasitic
infestation and a fungal infection. These are **medical conditions requiring diagnosis**,
not cosmetic concerns a webcam can assess.

- They are **excluded from scoring entirely** (`medical: true` filter in `scoreProducts`).
- No code path may recommend them from image analysis.
- The only route near them is an explicit symptom screen that ends in a
  **dermatologist referral**, never an add-to-cart.
- If you are ever tempted to "just let the engine consider them," stop and ask.

### 2. This is not a medical device
Never diagnose. Never claim certainty. All output is cosmetic and educational.
Every recommendation carries a confidence level and a disclaimer.
Severe acne, infection, lesions, spreading rash, persistent itch → **escalate to a
dermatologist and show zero products.**

### 3. Escalate early, not late
Triage questions run **before** the main consult. A user who needs a doctor must not sit
through a 7-question skincare consultation first. (This was a real bug; do not reintroduce it.)

### 4. Skin-tone fairness
Do not trust a vision provider's pigmentation/redness scores on brown skin without
validating them. A model that reads normal melanin as "sun damage" will tell every
customer they're damaged. Cap concern weights rather than accept raw scores if this shows up.

---

## Stack

- **Runtime:** TypeScript, Node 18+
- **Framework:** Next.js (App Router, route handlers)
- **DB/Storage:** Supabase (Postgres + private bucket, RLS on)
- **Hosting:** Vercel
- **Commerce:** Shopify (Storefront API for hydration/cart; Admin API server-only)
- **Vision:** third-party API (Haut.AI or Perfect Corp) behind a swappable adapter — **do not train a model**

---

## Architecture

The vision layer is an interface (`SkinVisionProvider`). Everything downstream consumes a
normalized `SkinAssessment`. Swapping providers must never require changes outside `/lib/vision`.

```
capture → quality gate → vision provider → SAFETY GATE (image flags)
   → triage questions → SAFETY GATE (answers) → confidence router
   → [clarify/consult questions → re-score] → recommendation engine
   → redundancy guard → explainability → Shopify hydration
```

Pipeline flow: `assess → safety → triage → route → question → re-score → recommend → explain`

### Module layout
```
/lib
  /vision        types.ts  provider.ts  hautai.ts  perfectCorp.ts  mock.ts
  /quality       laplacianBlur.ts  faceMesh.ts  gate.ts
  /confidence    router.ts
  /questions     bank.ts  select.ts  triage.ts
  /reco          catalog.ts  engine.ts  explain.ts  timelines.ts
  /safety        gate.ts  flags.ts
  /shopify       client.ts  hydrate.ts  cart.ts  webhooks.ts
  /db            schema.sql  repo.ts  rls.sql
  /privacy       consent.ts  purge.ts  erase.ts
  /analytics     events.ts
/app/api/skin/   session/ consent/ analyze/ questions/ answer/ recommend/ cart/ delete/
```

`skinEngine.ts` at the repo root is the working prototype of the core (catalog, scoring,
questions, safety, orchestrator) with a mock vision provider. It runs standalone:
`npx tsx skinEngine.ts`. Split it into the module layout above when wiring the real stack —
**do not rewrite its logic while doing so.** It is tested and correct.

---

## Recommendation engine

Weighted scoring, **not** keyword matching:

```
contribution = product_weight × concern_severity × concern_confidence
score        = Σ contributions × skin_type_fit_multiplier
```

- One product per slot (`cleanser`, `treatment`, `moisturizer`, `sunscreen`).
- `MINIMALISM_THRESHOLD = 0.08` — below this, don't add the product. No upsell filler.
- `REDUNDANCY_RATIO = 0.65` — drop a product whose top concern is already covered by a
  higher-scoring product, unless it scores ≥65% of the leader. Sunscreen is exempt.
- SPF is a baseline whenever pigmentation / sun damage / acne is present at severity > 0.2.
- Image quality **caps** confidence. A model can be 95% sure on a blurry photo; that
  certainty is worthless. `capped = min(avg, 0.6 + 0.4 × imageQuality)`.

### Open decision (ask before assuming)
Whether **cleanser should be a baseline slot** like sunscreen. Currently the redundancy guard
can leave a routine with no cleanser at all (e.g. dry + pigmented skin gets cream + SPF +
night cream, no wash). That may be too minimal for the business. **This is Mustafa's call,
not an engineering one — ask, don't decide.**

---

## Working style

- **Fix the actual problem.** Never suggest workarounds or fallbacks without explicit permission.
- Ask before making product/business judgment calls (routine composition, upsell posture,
  what counts as "minimal"). Engineering decisions you can make; commercial ones you cannot.
- Flag tradeoffs honestly rather than picking silently.
- Design sensibility: Apple / Notion / Linear. Dark themes, spring easing, minimal surfaces.
- **All communication in English**, regardless of input language.

---

## Privacy

Facial images are **biometric data** — treat as the most sensitive class.

- No image is stored without a `consent` row. Consent scopes are granular.
- Private Supabase bucket only. Never public URLs.
- Short default retention (24h) with a scheduled purge job. Longer only on explicit opt-in.
- `/delete` cascades rows + storage objects. Honor Shopify's `customers/redact` webhook.
- Vision API keys and Shopify Admin tokens are **server-only**. Never reach the client.
- Strip raw provider payloads of image data before persisting.

---

## Current state

- ✅ Core engine built, running, and debugged (`skinEngine.ts`)
- ✅ Safety gate verified: escalates on image flags, severe acne, itch/rash screens
- ✅ Weighted scoring + redundancy guard + explainability working
- ⬜ Real vision provider adapter (interface ready, implementation pending)
- ⬜ Supabase schema + persistence
- ⬜ Next.js API routes
- ⬜ Shopify hydration + cart
- ⬜ **Weight matrix tuning against real Fitzpatrick IV–VI captures** ← highest value, blocks trust

---

## The one thing to get right

The product/concern weight matrix in `catalog.ts`, tuned against **real photos of the actual
customer base** — not stock imagery, not defaults. That matrix plus the safety gate is the
whole product. The vision API and the Shopify wiring are commodity plumbing.