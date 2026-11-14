# Live 60-Second Judge Demo Script

## Pre-Demo Preflight (30 seconds before judges arrive)

1. Open the hosted Cloud Run URL (or `http://localhost:8080` after `npm run build && npm start`) in a clean incognito browser window at `1440x900` resolution.
2. Confirm the top status strip and post-IAM architecture header display:
   - `Synthetic persona: Tenant Alder (alder-operator)` and `Policy alder-context@7`
   - `Context mediation active` and `Google Gemini gemini-2.5-flash LIVE SDK`
   - `2/2 in this demo` (`Only this app's context and reply paths`, paired with `7 of 7` explicit exclusions)
   - `Post-IAM · Pre-Egress` and `GPU proof: NO GPU RUN RECORDED` (`0 of 1` live H200 GPU runs recorded in this build prior to `GPU GO`)
3. If a prior rehearsal left state on screen, click `Advanced` -> `Reset demo`, then click `Hide advanced` so `Run paired proof` sits cleanly above the fold.

---

## Primary 60-Second Live Walkthrough (`DEMO_MODE=live`)

### 0:00 - 0:14 | Beat 1: Post-IAM Hook & Paired Defect Run (`Native only` vs `Native + Vervain`)

- **Point at:** Top status strip (`Tenant Alder`, `Policy alder-context@7`), the `Post-IAM · Pre-Egress` architecture strip (`Okta · Microsoft Entra · WorkOS` -> `Vervain Runtime Firewall` -> `Google Gemini API + Open-Weight Runtimes` -> `Cyera · Palo Alto · Zscaler`), and click **`Run paired proof`**.
- **Point at both lanes as results land:**
  - Left card **`Native only`** (synthetic vulnerable control): amber badge `Cross-tenant context transmitted`, `2 of 2 retrieved chunks entered envelope`.
  - Right card **`Native + Vervain`** (governed boundary): green badge `Foreign context withheld before Gemini`, **`1 of 2 retrieved chunks admitted · 1 withheld`**, `epoch 7 -> 7`, `Released authorized answer` (`allowed_task=complete`).
- **Say:** "Okta or Entra tells us this session belongs to Tenant Alder under policy epoch 7, while egress DLP only inspects text after generation. Both lanes hit the exact same missing database filter returning 2 of 2 records. Under `Native only`, Tenant Beacon's restricted strategy note enters the Google Gemini envelope. Under `Native + Vervain`, our 6-step deterministic gate checks server-owned provenance before the Gemini SDK call, withholds 1 of 2 foreign chunks with `tenant_mismatch`, admits 1 of 2 authorized Alder chunks in a `WeakSet`-sealed envelope, rechecks epoch 7 before release, and delivers Alder's renewal summary."

### 0:14 - 0:30 | Beat 2: Isometric 3D Memory-Cube Provenance Graph, 6-Stage Scrubber & 5-Question Strip

- **Point at:** Lower-left **`Causal Provenance Graph`**, highlighting:
  1. The **isometric 3D wire-cube memory volume** (`AUDIT · ALERT · GOVERN`) sliced by the violet **`pre-inference cut-plane`**, where `source_beacon` terminates at the coral stop-bar (`withheld`) while `source_alder` crosses the aperture (`admitted`) through `context_gate` -> `gemini` -> `release_gate` -> `reply` (toggle `Native only` briefly if helpful to show `unmediated_passthrough`).
  2. The **6-stage causal replay scrubber** (`Replay trace` / `All 6 stages`: `1. Authority` -> `2. Retrieval` -> `3. Context Gate` -> `4. Provider Envelope` -> `5. Release Gate` -> `6. Receipt Chain`).
  3. The **5-question CISO governance strip** directly beneath (`WHO`, `WHAT`, `WHEN`, `HOW`, `WHY`).
- **Say:** "Inside the causal graph, Vervain's pre-inference cut-plane slices the inference memory cube before model execution: Beacon stops cold at Stage 3 (`Context Gate`), while Alder flows through all 6 of 6 replayable stages. Beneath the scrubber, the 5-question strip answers Who, What (`1/2 admitted · 1 withheld`), When (`epoch 7 -> 7`), How (`2 of 2` mediated boundaries), and Why (`tenant_mismatch`) at a glance."

### 0:30 - 0:44 | Beat 3: Content-Free SHA-256 Receipt Chain Verification

- **Point at:** Lower-right **`Bounded Causal Receipt`** (`1 of 2 retrieved chunks admitted (1 withheld, 0 unknown)`, `Foreign chunk entered Gemini envelope: no`, `Outbound envelope SHA-256`, and `Coverage & Explicit Exclusions`).
- **Click:** **`Verify receipt chain`** (confirm `verified` across the live instance's `6 of 6` stage events per run) and click **`Inspect JSON`** (or **`Export receipt JSON`**).
- **Say:** "Every run links 6 of 6 canonical JSON stage events into a SHA-256 receipt chain with 0 raw prompt, document, or API key bytes stored - while stating all 7 of 7 explicit exclusions, including that Google Gemini's internal KV cache is unmediated and in-memory chains exclude container-restart rollback without an external checkpoint."

### 0:44 - 1:00 | Beat 4: Open-Weight 4-Mode KV Lifecycle & Scoped Attention Workbench + Honest `NO GPU RUN RECORDED` Status

- **Scroll slightly to:** **`Self-Hosted Roadmap Layer: Scoped Attention & Open-Weight KV Lab`**.
- **Point first at:** **`Self-Hosted GPU / Carbon 3 Evidence Verifier`** card showing amber badge **`NO GPU RUN RECORDED`** (`verdict: NOT_CONFIGURED`, `No H200 artifact loaded prior to GPU GO`).
- **Click:** **`Open scoped attention proof`** and point at:
  1. The exact limitation banner (`Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.`).
  2. `Server-owned request scope tag: 0x00a1de07 (Tenant Alder)`, `1 of 4 blocks masked before softmax`, and `Foreign block post-softmax mass: 0.000000`.
  3. **`4-Mode Open-Weight KV & Prefix-Cache Lifecycle Explorer`** (`contaminated_block_table`, `prefix_cache_hash_collision` with `cache_salt`, `stale_allocation_generation`, `online_tiled_flash_recurrence`) and **`Online Block-Tiled (m_i, l_i, O_i) Flash Recurrence Trace`** (`0 reads (header skip)`).
- **Say:** "Roughly 1 of 3 enterprise tokens already run open-weight engines like vLLM, SGLang, Ollama, and NVIDIA Dynamo. Notice our independent Carbon 3 verifier badge honestly reports `NO GPU RUN RECORDED` - 0 of 1 live H200 GPU runs are recorded in this build prior to `GPU GO`. What runs live right here in deterministic TypeScript reference math is our 4-mode KV lifecycle workbench: salting prefix-cache hashes with `cache_salt` and checking `(scope_tag, alloc_generation)` block headers before tile load so foreign blocks get `0 reads` and `0.000000` post-softmax mass while clean blocks stay equivalent. Identity governs login; Vervain governs inference."

---

## Optional 15-Second Judge Q&A Beat: Mid-Generation Policy Revocation (`TOCTOU`)

If a judge asks *"What happens if access or deal-wall clearance is revoked while the model is already generating?"*:

1. Click **`Advanced`** -> **`Revoke during generation`**.
2. Point at **`Response withheld: policy_epoch_changed`**, `epoch 7 -> 8`, `allowed_task=incomplete`, and Stage `5. Release Gate` on the causal scrubber.
3. **Say:** "Admission bound epoch 7, the server session rotated to epoch 8 mid-flight, and the nonstreaming release gate withheld 100% of the buffered reply (`0` answer bytes released) while chaining both epochs into the receipt."
4. Click **`Reset demo`** to restore baseline `epoch 7`.

---

## Explicit Honest Fallback Paths (If Live Gemini API Fails or Hits Quota)

Never disguise an upstream provider error or offline mock transport as a live Gemini completion.

### Fallback Path A: Live Mode Degraded (`DEMO_MODE=live`, `provider_unavailable` or `rate_limited`)

If Google Gemini returns HTTP `429` / `503` after `<= 2` bounded retries (`3` attempts max), times out, or lacks `GEMINI_API_KEY` in `DEMO_MODE=live`:

1. Keep `DEMO_MODE=live` and click **`Run paired proof`** normally.
2. **On screen:** Pre-inference admission still executes deterministically (`1 of 2 retrieved chunks admitted · 1 withheld`, `foreign_tenant_chunk_present: false`), while the provider chip shows `provider_unavailable` or `rate_limited · LIVE`, `allowed_task=incomplete`, and `evidence_completeness: partial_provider_unavailable`.
3. **Spoken disclosure:** "Live Gemini returned `provider_unavailable` / `rate_limited`, and our server never substitutes a fake completion. Pre-inference admission still withheld 1 of 2 foreign chunks (`tenant_mismatch`) before envelope dispatch, marked `allowed_task` `incomplete`, and chained the exact outbound envelope SHA-256 digest."

### Fallback Path B: Explicit Offline Deterministic Transport (`DEMO_MODE=mock`)

Only if venue connectivity to Google Gemini is down and judges request full end-to-end release inspection:

1. Start explicitly with `DEMO_MODE=mock npm start` (or `DEMO_MODE=mock npm run dev`).
2. **Point immediately at:** Amber header badge **`MOCK TRANSPORT`**, lane chip **`MOCK`**, and `"transport_mode": "mock"` inside the receipt JSON.
3. **Spoken disclosure:** "Upstream Gemini network access is unavailable, so we enabled explicit `DEMO_MODE=mock`, labeled `MOCK TRANSPORT` in the header and inside every receipt. All 10 of 10 API authority checks, 6-step admission, release-time epoch and citation gating, SHA-256 hash chaining, and 4-mode KV reference math execute live on the server; only the downstream LLM text completion is deterministic synthetic transport."
