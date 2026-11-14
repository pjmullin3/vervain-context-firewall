# Vervain Context Firewall

Vervain stops another tenant's retrieved memory from entering an agent's Google Gemini context before inference, while preserving the authorized answer and issuing a payload-free causal receipt.

`Vervain Context Firewall` is a fresh-code hackathon prototype built around one inspectable multi-tenant failure mode: IAM establishes that the active caller is `Tenant Alder` (`alder-operator`, policy `alder-context@7`), yet a missing database predicate in retrieval (`cross_tenant_filter_omission`) returns both Alder's commercial playbook (`alder/renewal-playbook-v3`) and Tenant Beacon's restricted strategy note (`beacon/strategy-note-v2`, containing synthetic code `BEACON_PROJECT_EMBER_742` and an embedded document override instruction).

Running `Run paired proof` executes the frozen query (`fixture.northstar-renewal.v1`) across two synchronized arms:

- **`Native only` (intentionally vulnerable synthetic control):** Passes `2 of 2` retrieved chunks into the outbound Gemini envelope (`cross_tenant_context_transmitted`).
- **`Native + Vervain` (mediated context & release boundary):** Deterministic provenance validation withholds Beacon (`tenant_mismatch`), admits `1 of 2` retrieved chunks (`alder/renewal-playbook-v3`) into the server-assembled Google Gemini envelope via the official `@google/genai` SDK, rechecks session authority and policy epoch (`7 -> 7`) before reply release, delivers Alder's authorized commercial renewal guidance, and appends a SHA-256 hash-chained, content-free receipt.

---

## Two-Layer Architecture

Vervain separates hosted provider envelope governance from self-hosted paged-KV roadmap math and never claims visibility into Google Gemini's provider-internal KV cache.

```text
=======================================================================================
LAYER 1: HOSTED GOOGLE GEMINI PRE-INFERENCE CONTEXT & RELEASE BOUNDARY (LIVE APP PATH)
=======================================================================================

  [Browser Workspace]
    |  HttpOnly SameSite session cookie; client tenant/principal/epoch/model fields rejected
    v
  [Server Session Authority]
    |  Binds tenant_alder, principal:alder-operator, policy alder-context@7
    v
  [Retriever] --(named defect: cross_tenant_filter_omission)--> 2 retrieved chunks:
    |  1. alder/renewal-playbook-v3   (tenant_alder, customer-commercial, epoch 7)
    |  2. beacon/strategy-note-v2     (tenant_beacon, restricted-strategy, epoch 11)
    v
  +-----------------------------------------------------------------------------------+
  | Mediated Boundary 1: retrieval_to_gemini_context_envelope                         |
  | Deterministic Context Admission Gate (src/server/admission.ts)                    |
  |   1. Schema & recognized source check     4. Policy epoch check                   |
  |   2. Version & content SHA-256 match      5. Destination classification check     |
  |   3. Record tenant == session tenant      6. Byte & chunk count bounds            |
  |                                                                                   |
  |   -> beacon/strategy-note-v2 : WITHHELD (reason: tenant_mismatch)                 |
  |   -> alder/renewal-playbook-v3: ADMITTED (1 of 2 retrieved chunks admitted)       |
  +-----------------------------------------------------------------------------------+
    |  Typed AdmittedChunk[] only; withheld text never reaches envelope builder
    v
  [Outbound Gemini Envelope] --> [@google/genai Server SDK] --> [Google Gemini API]
    |                                                             (gemini-2.5-flash)
    v
  +-----------------------------------------------------------------------------------+
  | Mediated Boundary 2: gemini_response_to_browser_release                           |
  | Nonstreaming Response Release Gate (src/server/release.ts)                        |
  |   1. Reload live server session; confirm tenant, expiry, and policy epoch (7->7)  |
  |   2. Secondary exact-match check for synthetic planted value                      |
  +-----------------------------------------------------------------------------------+
    |
    +--> [Browser Reply: Authorized Northstar renewal guidance released]
    +--> [Bounded Causal Receipt + In-Instance SHA-256 Event Chain (zero raw text)]


=======================================================================================
LAYER 2: SELF-HOSTED ENGINE ROADMAP - SCOPED ATTENTION REFERENCE LAB (/api/demo/scoped-attention)
=======================================================================================

  [Server Session Scope Tag: 0x00a1de07] + [4-Block Paged KV Pool + Side Scope Array]
    |
    v
  [TypeScript Reference Paged Attention Math (src/server/scoped-attention.ts)]
    scores        = (Q @ K^T) / sqrt(d)
    combined_mask = ordinary_validity_mask AND (block_scope == request_scope)
    masked_scores = where(combined_mask, scores, -Infinity)
    weights       = stable_max_shifted_softmax(masked_scores)
    output        = weights @ V
    |
    v
  [Foreign-Scope Block #1 Masked Before Softmax -> Post-Softmax Mass = 0.000000]
  [Clean Allowed-Twin Equivalence Preserved | All-Masked & Invalid Block IDs Fail Closed]

  Limitation Notice (SCOPED_ATTENTION_LIMITATION_LABEL):
  "Reference scoped-attention proof. Not integrated with Gemini internals or a
   production vLLM attention backend. No latency or isolation claim."
```

---

## 60-Second Quickstart

Requires **Node.js >= 22.0.0** and **npm**.

### 1. Install dependencies

```bash
npm install
```

### 2. Configure `.env` from `.env.example`

```bash
cp .env.example .env
```

Edit `.env` locally (keep `.env` untracked; never commit API keys):

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | *(empty)* | Server-only Google Gemini API key read by `@google/genai`. Never exposed to client bundles. |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Configured Gemini model identifier (`temperature: 0`, `maxOutputTokens: 256`). |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` (enables `__Host-` HTTPS-only cookie prefix in `production`). |
| `PORT` | `8080` | HTTP port for the Node API and production static server. |
| `SESSION_SECRET` | *(ephemeral in dev)* | 32+ byte hex secret for HMAC-bound session tokens. Set explicitly in production. |
| `DEMO_MODE` | `live` | `live` uses official `@google/genai` SDK (reports `provider_unavailable` if unset/unreachable); `mock` uses deterministic offline transport visibly labeled `MOCK TRANSPORT`. |
| `ALLOW_LIVE_GEMINI` | `0` | Set to `1` only when executing bounded live Gemini smoke tests (`npm run test:live`). |
| `MAX_GEMINI_CALLS_PER_SESSION` | `12` | Per-session Gemini call budget guardrail. |
| `MAX_GEMINI_CALLS_PER_WINDOW` | `60` | Per-instance rolling 10-minute Gemini call budget. |
| `RATE_LIMIT_MUTATIONS_PER_MINUTE` | `20` | Per-session mutation endpoint rate limit. |

### 3. Run in development mode

```bash
npm run dev
```

Starts the Node API server on `http://localhost:8080` and the Vite React workspace on `http://localhost:5173`. (If `GEMINI_API_KEY` is unset and `DEMO_MODE` is not specified, `npm run dev` defaults to `mock` mode and displays `MOCK TRANSPORT` in the status strip; set `GEMINI_API_KEY` and `DEMO_MODE=live` for live Gemini calls.)

### 4. Build and run the production single-origin server

```bash
npm run build && npm start
```

Compiles the Vite client into `dist/client` and the TypeScript server into `dist/server`, then serves the single-origin app and API on `http://localhost:8080`.

---

## Verification Commands

Run every check from the repository root:

```bash
# Full deterministic Vitest suite (unit + integration + adversarial)
npm test

# Individual test tiers
npm run test:unit          # Session authority, strict JSON parser, admission, release, receipts, scoped-attention math
npm run test:integration   # Paired workflow, transport spy envelope checks, epoch revocation race, HTTP routes
npm run test:adversarial   # Authority spoofing, duplicate JSON keys, CSRF/Origin checks, content-free logs/receipts, chain tamper
npm run test:live          # Bounded live Google Gemini SDK smoke test (sets ALLOW_LIVE_GEMINI=1; requires GEMINI_API_KEY)
npm run test:e2e           # Playwright clean-browser end-to-end verification

# Static analysis
npm run typecheck          # Strict TypeScript check across client, shared, scripts, tests, and server
npm run lint               # ESLint verification across src and tests

# Proof & hygiene verifiers
npm run proof:paired       # Terminal paired-proof runner outputting JSON comparison of Native only vs Native + Vervain
npm run verify:bundle      # Confirms dist/client and tracked sources contain zero API keys, .env files, @google/genai bundles, or private paths
npm run verify:claims      # Scans UI, shared contracts, docs, one-pagers, and scripts for prohibited overclaims, em dashes, and limitation labels
npm audit                  # Dependency vulnerability audit
```

---

## HTTP API Surface

All mutation endpoints require `POST`, `Content-Type: application/json`, same-origin `Origin` / `Sec-Fetch-Site` headers, strict RFC 8259 duplicate-key-free JSON payloads within `8192` bytes, and zero client-supplied authority override headers, query parameters, or body fields (`tenant`, `principal`, `policy_epoch`, `scope`, `model`, `apiKey`, etc.):

- `POST /api/demo/session` - Initialize or rotate synthetic persona (`{"persona":"alder"}` or `{"persona":"beacon"}`).
- `POST /api/demo/reset` - Reset current synthetic session history and restore initial policy epoch.
- `POST /api/demo/run-paired` - Execute synchronized `Native only` vs `Native + Vervain` proof on the frozen fixture.
- `POST /api/demo/run-clean` - Execute governed single-arm request using the tenant-scoped retriever.
- `POST /api/demo/revoke-during-generation` - Advance session policy epoch mid-request (`7 -> 8`) and withhold response (`policy_epoch_changed`).
- `GET /api/demo/state` - Current synthetic session, runtime status, frozen query, latest runs, and chain summary.
- `GET /api/demo/scoped-attention` - Execute server-scoped 4-block reference paged-attention calculation.
- `GET /api/receipts/:receiptId` - Retrieve content-free receipt owned by the active session.
- `GET /api/receipts/:receiptId/export` - Download canonical JSON receipt attachment.
- `GET /api/ledger/verify` - Recompute and verify the in-instance SHA-256 event and receipt hash chain.
- `GET /healthz` and `GET /readyz` - Liveness and readiness probes.

---

## Deployment: Google Cloud Run & Google AI Studio

### Google AI Studio Build / Export

1. Import or open this repository workspace in Google AI Studio Build.
2. Set server runtime environment variables in the hosting environment (never inside client files or Git commits):
   - `GEMINI_API_KEY=<project_api_key>`
   - `GEMINI_MODEL=gemini-2.5-flash`
   - `DEMO_MODE=live`
   - `NODE_ENV=production`
   - `SESSION_SECRET=<64_char_random_hex>`
3. Build with `npm run build` and start with `npm start` (binds `PORT`, defaulting to `8080`).

### Google Cloud Run

1. Authenticate and target the designated Google Cloud project:

   ```bash
   gcloud auth login
   gcloud config set project <YOUR_GCP_PROJECT_ID>
   gcloud config set run/region us-central1
   ```

2. Store `GEMINI_API_KEY` and `SESSION_SECRET` in Secret Manager (or pass runtime-only environment variables from an untracked local shell) and deploy the single-origin service:

   ```bash
   gcloud run deploy vervain-context-firewall \
     --source . \
     --region us-central1 \
     --allow-unauthenticated \
     --port 8080 \
     --set-env-vars="NODE_ENV=production,DEMO_MODE=live,GEMINI_MODEL=gemini-2.5-flash,MAX_GEMINI_CALLS_PER_SESSION=12,MAX_GEMINI_CALLS_PER_WINDOW=60,RATE_LIMIT_MUTATIONS_PER_MINUTE=20" \
     --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,SESSION_SECRET=SESSION_SECRET:latest"
   ```

3. Verify the deployed service from a clean incognito browser window:
   - Check `https://<SERVICE_URL>/readyz` returns `"status": "ready"` and `"gemini_adapter_mode": "live"`.
   - Confirm the top status strip displays `Google Gemini`, `gemini-2.5-flash`, and `LIVE SDK`.
   - Click `Run paired proof`, export the JSON receipt, verify the receipt chain, and open the Scoped Attention Reference Lab.
   - Run `npm run build && npm run verify:bundle` locally before publishing to verify `dist/client` contains zero secrets or server SDK code.

---

## Exact Mediated Boundaries & Explicit Exclusions

### Mediated Boundaries (`2 of 2` in this application)

1. **`retrieval_to_gemini_context_envelope`**: Pre-inference deterministic context admission into this server-assembled Google Gemini outbound request envelope.
2. **`gemini_response_to_browser_release`**: Nonstreaming response release gate rechecking server-owned session authority, expiry, policy epoch, and exact synthetic planted-value absence before reply delivery to the browser.

### Explicit Exclusions & Unsupported Paths

Every UI receipt panel and exported JSON receipt (`vervain.context-firewall.receipt.v1`) records these exact boundaries and exclusions side by side:

- **`provider_internal_kv_cache_and_weights_unmediated`**: Google Gemini provider-internal KV cache, model weights, and provider scheduling are outside customer visibility and unmediated by this application.
- **`direct_unmediated_provider_calls_outside_this_server`**: Direct requests sent to the Gemini API outside this server process are unmediated.
- **`semantic_or_paraphrased_disclosure_beyond_exact_synthetic_planted_value_scan`**: Release-time output scanning checks exact synthetic planted strings (`BEACON_PROJECT_EMBER_742`) as secondary impact instrumentation and does not detect arbitrary semantic paraphrase. Primary protection is pre-inference envelope exclusion.
- **`nonstreaming_full_response_buffering_increases_time_to_first_token`**: Responses are buffered nonstreaming prior to release gating, trading higher time-to-first-token for pre-release policy-epoch verification.
- **`in_memory_hash_chain_without_external_checkpoint_does_not_detect_full_store_rollback`**: The in-memory SHA-256 event and receipt chain detects mutation within the live server instance, not full-store rollback or instance restart without an external checkpoint.
- **`synthetic_persona_selector_is_demo_fixture_not_enterprise_authentication`**: The persona selector switches opaque server-owned demo fixtures (`Tenant Alder` / `Tenant Beacon`) with session rotation and is not enterprise OIDC/IAM authentication.
- **`external_tools_databases_and_host_administrators_outside_demo_scope`**: External agent tool execution, third-party databases, and host administrators are outside prototype scope.
- **Scoped Attention Reference Lab (`SCOPED_ATTENTION_LIMITATION_LABEL`)**: `Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.`
