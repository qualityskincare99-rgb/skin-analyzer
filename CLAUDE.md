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

### 1. The four `Regulated` SKUs are hard-gated
Shopify tags these four **`Regulated`**. That tag is the source of truth. Anything
added to the store carrying it must be mirrored into `catalog.ts` with
`medical: true` and empty `addresses`.

| SKU | Product | What it is |
|---|---|---|
| `SCABQ-SOAP-75G` | ScabQ Anti-Scabies Soap | Parasitic infestation |
| `FUNGZAP-SOAP-75G` | FungZap Anti Fungal Soap | Fungal infection |
| `FWH-CREAM-15G` | FWH Cream | Fusidic acid + hydrocortisone |
| `BLASROK-20MG-10TAB` | Blasrok Tablets | Oral antihistamine, bilastine 20mg |

All four are **medical conditions requiring diagnosis**, not cosmetic concerns a
webcam can assess. They stay sellable in the store. They are invisible to the analyser.

- They are **excluded from scoring entirely** (`medical: true` filter in `scoreProducts`).
- No code path may recommend them from image analysis.
- The only route near them is an explicit symptom screen that ends in a
  **dermatologist referral**, never an add-to-cart.
- That screen (`persistent_itch`, `spreading_rash`) runs in **triage on every
  consultation, unconditionally**. Do not gate it on a vision signal. It was
  once gated on `redness.severity > 0.3`, which meant any assessment without
  detected redness skipped the screen entirely and went straight to products —
  and redness is the least reliable signal on Fitzpatrick IV–VI skin.
  `scripts/e2e.ts` scenario F guards this; do not weaken it.
- If you are ever tempted to "just let the engine consider them," stop and ask.

### 2. The page may not claim a measurement it did not take
While `VISION_PROVIDER=mock`, `/analyze` returns a fixed `DEMO_PRESET` and never
reads the frames. Anything on screen implying the photos were examined is a
fabricated reading of a real person's face, shown identically to every visitor.

Removed on 20 Oct 2026 and **not to be restored until a real adapter is live**:

| Gone | Why |
|---|---|
| The confidence ring (`#confArc`, `#confN`) | Rendered 91.6% for every single visitor |
| The "What we noticed" severity bars (`#concerns`) | Same four readings for everyone |
| "Here is what your skin told us" | Nothing was told |
| The "Face detection / Skin mapping" progress bars | No detection or mapping happens |
| "Photos are analysed and deleted within 24 hours" | They were neither |
| The name "Skin Analyser" | It is a consultation, not an analysis |

`analyze()` also **stops posting the frames**. Nothing server-side reads them,
so uploading a face photo nothing looks at was pure liability. They stay in
`S.frames` on the device and the customer downloads them at the end as a before
photo, which is the camera step's honest job until a model exists.

When an adapter lands, all of the above comes back **together**: the ring and
bars return, `{ frames:S.frames }` goes back into the `/analyze` body, and the
consent copy stops saying photos never leave the device, because at that point
it stops being true. Changing one without the others ships either a lie or a
broken feature.

### 3. This is not a medical device
Never diagnose. Never claim certainty. All output is cosmetic and educational.
Every recommendation carries a confidence level and a disclaimer.
Severe acne, infection, lesions, spreading rash, persistent itch → **escalate to a
dermatologist and show zero products.**

### 4. Escalate early, not late
Triage questions run **before** the main consult. A user who needs a doctor must not sit
through a 7-question skincare consultation first. (This was a real bug; do not reintroduce it.)

### 5. Skin-tone fairness
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

### Retention purge (`lib/privacy/purge.ts`)

`sessions.purge_after` is read by `runRetentionPurge`, reachable two ways:
`GET /api/skin/purge` (Vercel Cron, `CRON_SECRET` bearer) and `npm run purge`
(add `-- --dry-run` to list candidates without deleting).

Policy, past `purge_after`:

| consent | what happens |
|---|---|
| includes `store_results` | capture frames deleted, anonymous assessment rows kept |
| anything else | session cascade-deleted whole |

Frames are the biometric data and what the consent screen's promise covers, so
they always go. Concern scores carry no likeness and are exactly what the weight
matrix needs, so they survive an explicit grant. The UI currently always asks for
`store_results`, so every session takes row one today; the moment the screen
offers a real choice this honours it unchanged. `PURGE` audit rows outlive the
data by design (`audit_log` has no FK). Scenario H in `scripts/e2e.ts` guards all
of it.

**Open: the Vercel plan caps this.** Hobby allows one cron run per day, so a
24h TTL can mean up to ~48h of real retention, and the consent screen says
24 hours. Nothing is stored yet so nothing is currently broken, but this must
be settled **before** the vision adapter starts writing frames: Pro plan (hourly
cron), an external scheduler hitting the endpoint, or different copy. Mustafa's
call, it costs money.
- Vision API keys and Shopify Admin tokens are **server-only**. Never reach the client.
- Strip raw provider payloads of image data before persisting.

---

## Current state (17 Oct 2026)

- ✅ Core engine, safety gate, weighted scoring, redundancy guard, explainability
- ✅ Supabase schema + RLS applied; project `jmblealstpshoskwczhw` (free tier, auto-pauses)
- ✅ Next.js API routes, all six, with auth, consent gating and CORS
- ✅ UI at `public/analyzer/index.html`, wired to the API, no client-side scoring
- ✅ Deployed: `quality-skincare-analyzer.vercel.app/analyzer/index.html`
- ✅ SKUs aligned to the live Shopify store (`qualityskincare.pk`); real variant IDs in the page
- ✅ e2e suite against real Supabase — scenarios A–I
- ✅ Customer feedback: `POST /api/skin/feedback`, modal on results and referral
- ✅ Retention purge: `lib/privacy/purge.ts`, `GET /api/skin/purge`, `npm run purge`
- ✅ Calibration harness: `npm run calibrate -- --dir <folder>` (see below)
- ⬜ Real vision provider adapter — **the only thing standing between this and a real product**
- ⬜ Image storage (`saveAnalysis` is still called with `imageRefs: []`)
- ⬜ **Weight matrix tuning against real Fitzpatrick IV–VI captures** ← blocks trust

### Calibration harness (`scripts/calibrate.ts`)

```
npm run calibrate -- --init-labels --dir ./captures   # scaffold labels.json
npm run calibrate -- --dir ./captures --csv out.csv   # run and score
```

Pushes every capture through the real HTTP path, reads the raw assessment back
from the `analyses` row, and reports false positives per concern **and per
Fitzpatrick type** — the rule-4 failure made measurable. Frames are centre-cropped
square and JPEG-encoded at q90 to match what `#shutter` actually sends; feeding a
12MP phone PNG to a vendor would calibrate against a fiction. It refuses to let a
mock run look real: if every assessment comes back byte-identical it says so in a
banner before any accuracy figure.

Ground truth lives in `labels.json` beside the captures. `fitzpatrick` and
`absent` are the two fields that do the work.

### Customer feedback

`POST /api/skin/feedback`. The question is chosen **server-side from the session
state**, never from the request body: `PRESENT` → a 1-5 rating, `ESCALATE` → a
clarity verdict. The wrong shape is a 400, so the two populations cannot blur.
Not consent-gated: a review is the customer's own words about the service, not
an inference drawn from their face.

A unique index on `session_id` makes one-review-per-session a database fact
rather than a route convention. `feedback` has **no FK to sessions**, so the
retention purge cannot take it; `deleteAllForSession` deletes it by hand,
because an erasure request should. The `extra` jsonb column is where
per-concern accuracy labels go if they are ever added, with no second migration.

In the UI: `FEEDBACK_DELAY_MS` (12s) after a result, or `FEEDBACK_AFTER_CART_MS`
(1.5s) after Add to bag, whichever comes first — the cart click is the
conversion, so after it the prompt costs nothing. Once per consultation;
dismissing counts as answering.

Caveat worth keeping in view: while the provider is mock, ratings measure the
flow and the copy. They say nothing about accuracy, because there is no
analysis to be accurate about.

### Known gaps worth not forgetting
- `/analyze` returns a fixed `DEMO_PRESET` and does not read the frames. Every
  consultation yields the same assessment until an adapter lands. The calibration
  harness detects this and shouts; do not remove that check when the adapter lands.
- `flow.ts` re-implements the orchestrator's state machine for the HTTP path.
  Equivalence is asserted in a comment, not proven. Change both or neither.
- `SESSION_JWT_SECRET` doubles as the Supabase JWT secret. One leak reads every session.
- `Qolagen-Q` (oral collagen) is in the store and absent from the engine. Undecided,
  not forgotten.

---

## The one thing to get right

The product/concern weight matrix in `catalog.ts`, tuned against **real photos of the actual
customer base** — not stock imagery, not defaults. That matrix plus the safety gate is the
whole product. The vision API and the Shopify wiring are commodity plumbing.