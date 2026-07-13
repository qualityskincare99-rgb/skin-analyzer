# Quality SkinCare — AI Skin Analyzer Engine
## Production Technical Specification & Implementation Plan

**Scope:** The UI (camera page) exists. This document specifies the *backend intelligence* — CV pipeline, confidence logic, dynamic questioning, recommendation engine, explainability, Shopify wiring, data model, security, and deployment. Written for a Next.js + Supabase + Vercel + Shopify stack.

---

## 0. Two decisions baked into this design

| Decision | Choice | Rationale |
|---|---|---|
| Vision model | **Buy** (Perfect Corp / Haut.AI) behind a swappable adapter | Training a fair, tone-robust dermatological classifier is infeasible here; commercial APIs benchmark 90–96% vs. dermatologist labels across Fitzpatrick I–VI. Customers here are predominantly Fitzpatrick IV–VI; a self-trained model will pathologize normal melanin. |
| Medical SKUs | **Hard-gate** Scabies Treatment Soap & Anti Fungal Soap | Scabies (parasitic) and tinea/fungal infection are medical diagnoses. Never surface from image analysis. Reachable only via explicit symptom flow → dermatologist escalation. |

The vision layer is an interface (`SkinVisionProvider`). Start with a commercial API, swap later — the rest of the system doesn't change.

---

## 1. System architecture

```
┌─────────────────────────────────────────────────────────────┐
│  EXISTING UI  (Shopify theme — do not touch)                 │
│  camera capture · lighting overlay · results view            │
└───────────────┬─────────────────────────────────────────────┘
                │ HTTPS (signed session) — CORS allowlist Shopify domain
┌───────────────▼─────────────────────────────────────────────┐
│  EDGE API  (Next.js route handlers on Vercel)                │
│  /session  /analyze  /answer  /recommend  /consent  /delete  │
└───┬───────────┬───────────┬──────────────┬──────────────────┘
    │           │           │              │
┌───▼───┐  ┌────▼─────┐ ┌───▼────────┐ ┌───▼──────────────┐
│Image  │  │Skin      │ │Confidence  │ │Recommendation    │
│Quality│  │Vision    │ │+ Question  │ │Engine (weighted) │
│Gate   │  │Provider  │ │Engine      │ │+ Explainability  │
│       │  │(adapter) │ │            │ │+ Safety Gate     │
└───────┘  └──────────┘ └────────────┘ └───┬──────────────┘
                                            │
┌────────────────────────────────────┐  ┌───▼──────────────┐
│  Supabase (Postgres + Storage)     │  │  Shopify         │
│  sessions · analyses · answers ·   │  │  Storefront API  │
│  recommendations · consent · audit │  │  (product/cart)  │
│  Images: PRIVATE bucket, TTL purge │  │                  │
└────────────────────────────────────┘  └──────────────────┘
```

**Flow:** session → consent → capture 3 frames → quality gate → vision provider → safety gate (image flags) → triage questions → safety gate (answers) → confidence router → clarify/consult questions → re-score → recommendation engine → redundancy guard → explainability → Shopify hydration → persist → scheduled image purge.

---

## 2. Consultation state machine

```
INIT ──consent──▶ CAPTURE ──3 valid frames──▶ ANALYZING
                     ▲                            │
                     └──── quality_fail ──────────┘
ANALYZING ──▶ SAFETY (image flags) ──▶ TRIAGE (1-2 Q if warranted)
          ──▶ SAFETY (answers) ──▶ CONFIDENCE_ROUTER
   ├─ conf ≥ 0.90 ─────────────▶ RECOMMEND
   ├─ 0.70 ≤ conf < 0.90 ──────▶ CLARIFY (3 targeted Q)
   └─ conf < 0.70 ─────────────▶ CONSULT (full Q set)
CLARIFY / CONSULT ──answers──▶ RE-SCORE ──▶ RECOMMEND
RECOMMEND ──▶ HYDRATE_SHOPIFY ──▶ PRESENT ──▶ (optional) ADD_TO_CART
Any stage ──medical_flag──▶ ESCALATE (derm referral, zero products)
```

**Triage runs before the main consult.** A user who needs a dermatologist must not sit through 7 questions first.

---

## 3. Image quality gate

Reject bad input *before* spending a vision API call. Client-side first (instant feedback), re-validated at the edge (never trust the client).

| Check | Method | Threshold |
|---|---|---|
| Face present & single | MediaPipe FaceMesh landmarks | 468 landmarks, 1 face |
| Pose | yaw/pitch from landmark geometry | front: \|yaw\|<12°; profile: 55–90° |
| Blur | variance of Laplacian | > 100 |
| Exposure | mean luma + clipped-pixel ratio | luma 90–190; clipped < 5% |
| Face coverage | face bbox area / frame area | 0.15–0.6 |
| Occlusion | landmark visibility | key regions visible |

Each failure maps to a specific user message ("move closer", "too dark", "hold still").

---

## 4. Vision provider adapter

The only place that knows about the third-party API. Everything downstream consumes the normalized `SkinAssessment`.

```ts
export type SkinType = 'dry' | 'oily' | 'combination' | 'normal' | 'sensitive';

export type ConcernKey =
  | 'acne' | 'acne_scars' | 'hyperpigmentation' | 'uneven_tone'
  | 'dark_spots' | 'fine_lines' | 'wrinkles' | 'enlarged_pores'
  | 'redness' | 'dry_patches' | 'excess_oil' | 'dehydration'
  | 'dullness' | 'sun_damage' | 'dark_circles';

export interface ConcernScore {
  key: ConcernKey;
  severity: number;     // 0..1
  confidence: number;   // 0..1
}

export interface SkinAssessment {
  skinType: { value: SkinType; confidence: number };
  concerns: ConcernScore[];
  imageQualityScore: number;
  medicalFlags: string[];      // ['possible_infection','suspicious_lesion',...]
  provider: string;
  raw?: unknown;               // audit only; strip before client
}

export interface SkinVisionProvider {
  analyze(frames: { front?: Buffer; left?: Buffer; right?: Buffer }): Promise<SkinAssessment>;
}
```

Each provider adapter maps its own labels onto the canonical `ConcernKey` set. Swapping providers must never require changes outside `/lib/vision`.

---

## 5. Confidence routing

```ts
export function routeByConfidence(a: SkinAssessment) {
  // Weight each concern's confidence by severity — a severe concern we're
  // unsure about should pull us toward asking questions.
  const weighted = a.concerns.map(c => ({ w: c.severity + 0.1, c: c.confidence }));
  const num = weighted.reduce((s, x) => s + x.w * x.c, 0);
  const den = weighted.reduce((s, x) => s + x.w, 0) || 1;
  const avg = num / den;

  // Poor image quality CAPS confidence regardless of model certainty.
  const capped = Math.min(avg, 0.6 + 0.4 * a.imageQualityScore);

  if (capped >= 0.90) return { route: 'RECOMMEND', confidence: capped };
  if (capped >= 0.70) return { route: 'CLARIFY', confidence: capped };
  return { route: 'CONSULT', confidence: capped };
}
```

**Key nuance:** image quality caps confidence. A model can be 95% sure on a blurry, backlit frame — that certainty is worthless. This alone prevents most bad recommendations.

---

## 6. Question engine

Questions reduce uncertainty on the *specific* concerns detected — not a fixed script. Each maps to concerns and adjusts their severity/confidence.

Selection: pick the N questions whose targets have the highest **severity × uncertainty**.

- `CLARIFY` → 3 targeted questions
- `CONSULT` → full lifestyle/history set (~5), plus contraindications (allergies, current retinol, pregnancy)

**Triage questions** are separate and run first, only when the assessment warrants:
- acne severity > 0.8 → ask if breakouts are painful/deep (→ possible escalation)
- redness severity > 0.3 → fungal/parasitic symptom screen (→ dermatologist referral)

These are **not** asked routinely. Asking every low-confidence user about scabies symptoms is alarming and unnecessary.

---

## 7. Recommendation engine (weighted, not keyword)

This is the actual IP.

```
contribution = product_weight × concern_severity × concern_confidence
score        = Σ contributions × skin_type_fit_multiplier
```

- **One product per slot**: cleanser, treatment, moisturizer, sunscreen.
- **`MINIMALISM_THRESHOLD = 0.08`** — below this, don't add the product. No upsell filler.
- **`REDUNDANCY_RATIO = 0.65`** — drop a product whose top concern is already covered by a higher-scoring product, unless it scores ≥65% of the leader. Sunscreen exempt.
- **SPF baseline** whenever pigmentation / sun damage / acne present at severity > 0.2.
- **Medical SKUs filtered out before scoring** — they never enter the engine.

### Catalog (weights tuned per concern)

| SKU | Product | Slot | Time | Addresses |
|---|---|---|---|---|
| QSC-BFW | Brightening Face Wash | cleanser | both | dullness, uneven tone, pigmentation |
| QSC-SPF50 | Sunblock SPF 50 | sunscreen | am | sun damage, pigmentation, dark spots |
| QSC-NC | Night Cream | moisturizer | pm | dry patches, dehydration, fine lines |
| QSC-BC | Brightening Cream | treatment | pm | pigmentation, dark spots, uneven tone |
| QSC-AAFW | Anti Acne Face Wash | cleanser | both | acne, excess oil, pores |
| QSC-AAC | Anti Acne Cream | treatment | pm | acne, acne scars |
| QSC-AAS | Anti Acne Soap | cleanser | both | acne, excess oil |
| QSC-BS | Brightening Soap | cleanser | both | dullness, uneven tone |
| QSC-STS | Scabies Treatment Soap | — | — | **MEDICAL — hard-gated, never recommended** |
| QSC-AFS | Anti Fungal Soap | — | — | **MEDICAL — hard-gated, never recommended** |

### Open decision
Whether **cleanser should be a baseline slot** like sunscreen. The redundancy guard can currently leave a routine with no cleanser at all. This is a business call, not an engineering one.

---

## 8. Explainability

Every recommendation ships with a human, non-clinical sentence built from its actual score drivers:

> "We clearly noticed excess oil and active breakouts. Anti Acne Face Wash targets this — best used morning and night."

Certainty language is derived from confidence: ≥0.9 "clearly", ≥0.75 "likely", else "possibly". Never claim certainty. Result timelines are ranges, never promises (acne 4–6wk, pigmentation 6–8wk, hydration 1–2wk, SPF ongoing).

---

## 9. Database schema (Postgres / Supabase)

```sql
-- Consent is a hard prerequisite; no image touches storage without a row here.
create table consent (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null,
  scope         text[] not null,          -- {'image_analysis','store_results','marketing'}
  ip_hash       text,                     -- hashed, never raw IP
  granted_at    timestamptz not null default now(),
  revoked_at    timestamptz
);

create table sessions (
  id            uuid primary key default gen_random_uuid(),
  shopify_customer_id text,               -- null for guests
  state         text not null default 'INIT',
  skin_type     text,
  skin_type_conf real,
  route         text,                     -- RECOMMEND | CLARIFY | CONSULT | ESCALATE
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  purge_after   timestamptz               -- images purged past this
);

create table analyses (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid references sessions(id) on delete cascade,
  provider      text not null,
  image_quality real,
  concerns      jsonb not null,           -- [{key,severity,confidence}]
  medical_flags text[],
  image_refs    text[],                   -- storage paths, purged on TTL
  created_at    timestamptz default now()
);

create table answers (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid references sessions(id) on delete cascade,
  question_id   text not null,
  value         text not null,
  created_at    timestamptz default now()
);

create table recommendations (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid references sessions(id) on delete cascade,
  routine       jsonb not null,           -- [{sku,slot,when,score,explanation,drivers}]
  escalated     boolean default false,
  escalation_reason text,
  created_at    timestamptz default now()
);

create table audit_log (
  id            bigserial primary key,
  session_id    uuid,
  event         text not null,            -- CONSENT_GRANT, ANALYZE, ESCALATE, PURGE, DELETE_REQ
  meta          jsonb,
  at            timestamptz default now()
);

-- RLS: a session can only read its own rows (enforced via signed session claim).
alter table sessions        enable row level security;
alter table consent         enable row level security;
alter table analyses        enable row level security;
alter table answers         enable row level security;
alter table recommendations enable row level security;
```

**RLS is mandatory on every table holding user data. Policies must exist, not just the flag.**

---

## 10. API endpoints

All under `/api/skin/*`, Next.js route handlers, session-scoped JWT (short TTL), rate-limited. **CORS must allowlist the Shopify storefront domain** or the browser will block every call.

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/session` | Create session, return signed session token |
| `POST` | `/consent` | Record consent scope (required before analyze) |
| `POST` | `/analyze` | Upload 3 frames → quality gate → vision provider → route |
| `GET`  | `/questions` | Return selected questions for current route |
| `POST` | `/answer` | Submit answers, re-score, advance state |
| `POST` | `/recommend` | Safety gate + engine, hydrate Shopify, return routine |
| `POST` | `/cart` | Build Shopify cart from chosen SKUs, return checkout URL |
| `GET`  | `/session/:id` | Resume state |
| `POST` | `/delete` | GDPR erase: purge images + rows, log |

---

## 11. Shopify integration

The engine returns SKUs; **Shopify is the source of truth** for price/availability/URLs. Storefront API (client-safe token) for hydration and cart; Admin API server-side only.

- **Catalog binding:** add a metafield `custom.qsc_sku` (or a tag) to each Shopify product matching the internal SKU, so engine and store never drift.
- **Out of stock:** if a recommended SKU is unavailable, fall back to the next-best product in the same slot rather than showing an unbuyable item.
- **Cart:** `cartCreate` mutation → return `checkoutUrl`. Works with Online Store 2.0.

**Deployment shape:** the engine deploys to Vercel as its own app. The existing Shopify analyzer page calls its `/api/skin/*` routes over HTTPS. Nothing is installed *into* Shopify — the theme page becomes a client of the API.

---

## 12. Security & privacy

Facial images are **biometric data** — the most sensitive class in this system.

- **Consent-first:** no upload without a `consent` row. Granular scopes (`image_analysis` ≠ `store_results` ≠ `marketing`).
- **Ephemeral by default:** private Supabase Storage bucket, never public URLs. Short retention (24h default); longer only on explicit opt-in for progress tracking. Scheduled purge job past `purge_after`, logged.
- **Encryption:** TLS in transit, encrypted at rest. Raw provider payloads stripped of image data before persistence. IPs hashed.
- **Right to erasure:** `/delete` cascades all rows + storage objects, writes audit entry. Honor Shopify's `customers/redact` webhook.
- **Access:** RLS so a session reads only its own data. Vision API key and Shopify Admin token are server-only and never reach the client.
- **Not a medical device:** cosmetic/educational disclaimer at consent and on results. The escalation path is the compliance backbone.

---

## 13. Monitoring & analytics

| Signal | Why |
|---|---|
| Quality-gate reject rate by reason | Fix the overlay / lighting guidance |
| Route distribution (RECOMMEND/CLARIFY/CONSULT) | Mostly CONSULT ⇒ image quality or provider is weak |
| Concern frequency | Merchandising + stock decisions |
| Recommend → add-to-cart → checkout funnel | The CRO number that justifies the build |
| Escalation rate + reasons | Safety monitoring; spikes warrant investigation |
| Vision API latency & error rate | Vendor health |
| **Per-concern confidence histograms by skin tone** | **Detect model drift / unfairness on Fitzpatrick IV–VI** |

Aggregate only. No PII or biometric data in analytics.

---

## 14. Deployment

- **Frontend/UI:** existing Shopify theme (unchanged)
- **API:** Next.js route handlers on Vercel
- **DB/Storage:** Supabase (Postgres + private bucket)
- **Vision:** third-party API behind the adapter
- **Jobs:** scheduled image purge + Shopify webhook handlers
- **Secrets:** vision key, Shopify tokens, Supabase service key — all server-only env vars

### Testing ladder
1. Local, mock vision provider — no vendor, no store
2. Local, full stack — real Supabase, mock vision
3. Deployed, real vision — **test with 20+ real Fitzpatrick IV–VI faces**
4. Shopify **duplicate theme** (unpublished preview) → real products, real cart, zero risk
5. Publish theme

---

## 15. Implementation plan

**Phase 0 — Foundations.** Schema + RLS, session/consent endpoints, Shopify catalog metafield binding, vision adapter interface with mock provider. Whole flow green on fake data.

**Phase 1 — Real vision.** Wire one provider, implement normalizer + medical-flag derivation, client quality gate, edge re-validation.

**Phase 2 — Intelligence.** Confidence router, question engine, triage, re-scoring, recommendation engine, explainability, safety gate. **Tune the weight matrix against real captures of the target skin tones.**

**Phase 3 — Commerce + trust.** Shopify hydration, cart/checkout, out-of-stock fallback, escalation UX, disclaimers, `/delete` + Shopify redact webhook.

**Phase 4 — Ops.** Analytics, monitoring, rate limiting, image purge job, load test, skin-fairness QA pass.

---

## 16. Module structure

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

---

### The one thing to get right first

Tune the **product/concern weight matrix against real photos of Fitzpatrick IV–VI skin**, not stock imagery. That matrix plus the safety gate is the whole product — the vision API and Shopify wiring are commodity plumbing. Get those two right and the rest follows.