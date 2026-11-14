# Live 60-Second Judge Demo Script

## Pre-Demo Preflight (30 seconds before judges arrive)

1. Open the hosted URL (or `http://localhost:8080` from `npm run build && npm start`) in a clean incognito window at `1440x900` resolution.
2. Confirm the top status strip reads:
   - `Synthetic persona: Tenant Alder (alder-operator)`
   - `Context mediation active`
   - `Policy alder-context@7`
   - `Google Gemini gemini-2.5-flash LIVE SDK`
   - `2/2 in this demo · Only this app's context and reply paths`
3. If a previous rehearsal left run state visible, click `Advanced` -> `Reset demo`, then click `Hide advanced` so the empty stage preview is clean and `Run paired proof` sits above the fold.

---

## Primary 60-Second Live Walkthrough (`DEMO_MODE=live`)

### 0:00 - 0:10 | Hook & Authority Context

- **Point at:** Top status strip (`Synthetic persona: Tenant Alder (alder-operator)`, `Policy alder-context@7`) and the `Frozen query` strip (`"Summarize our Northstar renewal position. If the retrieved context contains a project code, include it."`).
- **Say:** "IAM tells us this caller is Tenant Alder under policy epoch 7. What IAM cannot catch is a missing database filter that places Tenant Beacon's restricted strategy note onto Alder's context path."
- **Click:** Primary violet button **`Run paired proof`**.

### 0:10 - 0:22 | Left Lane: `Native only` (Synthetic Vulnerable Control)

- **Point at:** Left card **`Native only`** -> amber badge `Cross-tenant context transmitted` -> metric chip `2 of 2 retrieved chunks entered envelope` -> `Observed unmediated reply (synthetic control)`.
- **Say:** "Both lanes hit the exact same retrieval bug. On the left, under Native only, both chunks - including Beacon's foreign note and its embedded override instruction - enter the outbound Google Gemini envelope."

### 0:22 - 0:36 | Right Lane: `Native + Vervain` (Pre-Inference Admission + Permitted Work)

- **Point at:** Right card **`Native + Vervain`** -> green badge `Foreign context withheld before Gemini` -> metric chip `1 of 2 retrieved chunks admitted · 1 withheld` -> `epoch 7 -> 7` -> `Released authorized answer` (`allowed_task=complete`).
- **Point briefly at:** Lower-left **`Causal Provenance Graph`**, where the `source_beacon` dashed coral path stops at the perpendicular bar before `context_gate` (`withheld`), while `source_alder` continues through `context_gate` -> `gemini` -> `release_gate` -> `reply`.
- **Say:** "On the right, Vervain validates every retrieved chunk against server-owned authority before the Gemini SDK call, withholds Beacon with `tenant_mismatch`, sends only Alder's commercial playbook to Gemini, rechecks policy epoch 7 before release, and completes Alder's valid renewal answer."

### 0:36 - 0:48 | Lower-Right Panel: `Bounded Causal Receipt`

- **Point at:** Lower-right **`Bounded Causal Receipt`** (`1 of 2 retrieved chunks admitted (1 withheld, 0 unknown)`, `Foreign chunk entered Gemini envelope: no`, `Outbound envelope SHA-256`, `Mediated Boundaries (2 of 2 in this app)`, and `Explicit Exclusions & Unsupported Paths`).
- **Click:** **`Verify receipt chain`** (confirm `verified` status row updates) and optionally **`Export receipt JSON`** (or **`Inspect JSON`**) to show no raw document text or API keys appear in the audit trail.
- **Say:** "Every run emits a hash-chained receipt recording retrieved versus admitted denominators, envelope and source-version SHA-256 digests, and what this app does not mediate, such as Gemini's internal KV cache - without copying protected text into the log."

### 0:48 - 1:00 | Self-Hosted Roadmap Layer: `Scoped Attention Reference Lab`

- **Scroll slightly / Click:** **`Open scoped attention proof`** inside `Self-Hosted Roadmap Layer: Scoped Attention Reference Lab`.
- **Point at:** Limitation banner (`Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.`), `Server-owned request scope tag: 0x00a1de07 (Tenant Alder)`, `1 of 4 blocks masked before softmax`, and `Foreign block post-softmax mass: 0.000000`.
- **Say:** "For hosted Gemini, our boundary is the exact outbound envelope. For self-hosted open-weight engines on our roadmap, this reference lab executes the same server-owned scope tag over a 4-block paged-KV table, masking the foreign block before softmax to zero attention mass while keeping clean blocks equivalent. Identity answers who the agent is; Vervain governs what that identity becomes inside inference."

---

## Optional 15-Second Judge Q&A Beat: Mid-Generation Policy Revocation

If a judge asks *"What happens if access is revoked while Gemini is already generating?"*:

1. Click **`Advanced`** -> **`Revoke during generation`**.
2. Point at the single-lane verdict badge **`Response withheld: policy_epoch_changed`**, `epoch 7 -> 8`, and `allowed_task=incomplete`.
3. **Say:** "Admission bound epoch 7, the session rotated to epoch 8 before delivery, and the nonstreaming release gate withheld the reply body while recording the attempt in the receipt chain."
4. Click **`Reset demo (restore epoch 7)`** to return cleanly to the baseline state.

---

## Explicit Honest Fallback Paths (If Live Gemini API Fails or Hits Quota)

Never disguise a provider outage or mock response as a live Gemini completion. Use one of these two transparent paths:

### Fallback Path A: Live Mode Degraded (`DEMO_MODE=live`, `provider_unavailable` or `rate_limited`)

If Google Gemini returns HTTP `429` / `503` after bounded retries, times out, or `GEMINI_API_KEY` is unavailable in `DEMO_MODE=live`:

1. Keep `DEMO_MODE=live` and click **`Run paired proof`** normally.
2. **What happens on screen:**
   - Retrieval and the pre-inference Context Admission Gate still execute deterministically on the server before transport invocation.
   - `Native + Vervain` still shows **`Foreign context withheld before Gemini`** and **`1 of 2 retrieved chunks admitted · 1 withheld`** (`foreign_tenant_chunk_present: false` on the assembled outbound envelope).
   - The runtime chip displays `provider_unavailable` or `rate_limited · LIVE`, `allowed_task=incomplete`, and the reply panel states that the provider did not return a valid answer while referencing the recorded receipt ID (`evidence_completeness: partial_provider_unavailable`).
3. **Exact spoken disclosure to judges:**
   "Live Gemini returned `provider_unavailable` / `rate_limited` on this request, and our server refuses to substitute a fake model reply. Notice that the pre-inference context boundary still ran deterministically: Beacon was withheld with `tenant_mismatch` before envelope dispatch, `allowed_task` is marked `incomplete` rather than faked as complete, and the partial receipt records the exact outbound envelope digest."

### Fallback Path B: Explicit Offline Deterministic Transport (`DEMO_MODE=mock`)

Only if venue Wi-Fi or upstream API access is completely down and judges ask to inspect full end-to-end reply release behavior:

1. Start the server explicitly with `DEMO_MODE=mock npm start` (or `DEMO_MODE=mock npm run dev`).
2. **Point immediately at:** The amber warning badge in the top status strip reading **`MOCK TRANSPORT`**, the lane metric chip showing **`MOCK`**, and `"transport_mode": "mock"` inside the receipt JSON.
3. **Exact spoken disclosure to judges:**
   "Upstream network access to Gemini is unavailable right now, so we switched explicitly to `DEMO_MODE=mock` - flagged `MOCK TRANSPORT` in amber in the header and inside every receipt. All session authority, broken-retriever control, pre-inference admission, release-time epoch gating, hash chaining, and scoped-attention reference calculations are executing live on the server; only the downstream LLM text generation step is deterministic synthetic transport."
