# Carbon 1 Product Lead Handoff - Vervain Context Firewall (`main`)

## 1. Worktree, Branch & Integrated Lane SHAs

- **Lead Worktree:** `/Users/pjmullin/Desktop/vervain-carbon-demo`
- **Branch:** `main`
- **Builder Session:** `conversation://7fa3bbaa-43b7-4edf-827a-a52efebe161f`
- **GPU Hold Status:** Respected `100%` (`0` GPU, pod, cluster, or remote host connections attempted prior to `10:00 AM PT` + explicit owner `GPU GO`; default runtime and UI state displays `NO GPU RUN RECORDED`).

| Swarm Lane | Source Worktree & Branch | Source Commit SHAs | Status on `main` |
| :--- | :--- | :--- | :--- |
| **Builder 1: Product Lead (Full-Stack App, Gemini SDK, Receipts, Open-Weight KV Workbench)** | `/Users/pjmullin/Desktop/vervain-carbon-demo` (`main`) | `fe54534`, `517aa6e`, `4d24aa0` | **Integrated & Verified** (`105/105` Vitest, `2/2` Playwright E2E, `8` adversarial cycles) |
| **Daybreak Security Loop** | `/Users/pjmullin/Desktop/vervain-carbon-daybreak` (`daybreak/security-loop`) | `37e16ed`, `d78fc35` | **Integrated & Superseded** (`Cycles 1-8` on `main` in `SECURITY_LEDGER.md`) |
| **Builder 3: Independent Evidence Verifier** | `/Users/pjmullin/Desktop/vervain-carbon-evidence-lane` (`carbon/evidence`) | `1f40eb0`, `0d8df46` | **Cherry-Picked & Wired on `main`** (`b147780`, `9c44b2d`; `CARBON3_HANDOFF.md` + `CARBON3_HANDOFF.json`, `npm run verify:evidence` green) |
| **Builder 4: Judge Causal Replay (`@vervain/judge-replay`)** | `/Users/pjmullin/Desktop/vervain-carbon-experience-lane` (`carbon/experience`) | `339b07f`, `b5e65d5`, `3bee8f0`, `4a6157e` | **Cherry-Picked & Mounted on `main`** (`c25d363`..`4b14a6f`; embedded inside `ScopedAttentionLab.tsx` with `5` pre-GPU fixtures) |
| **Builder 2: Self-Hosted `vLLM` Paged-KV Enforcement** | `/Users/pjmullin/Desktop/vervain-carbon-inference-lane` (`carbon/scoped-attention`) | Base `6c1fd6e` (lane builder active in isolated worktree) | **Typed Seam Ready on `main`** (`INFERENCE_PROOF_ARTIFACT_PATH` + `GET /api/inference-proof` + Carbon 3 verifier ready for post-`GPU GO` artifact) |

---

## 2. Delivered Architecture & Product Capabilities on `main`

1. **Hosted Google Gemini Pre-Inference Context & Release Firewall (`active_in_this_app`):**
   - Server-owned HMAC-SHA256 session authority (`src/server/session.ts`) with persona rotation, `SessionCapacityError` `503` active-session preservation, and atomic provider quota reservation (`12`/session, `60`/`10`-min window, `20` mutations/min).
   - Paired comparison (`POST /api/demo/run-paired`) on frozen query `fixture.northstar-renewal.v1`: `Native only` transmits `2 of 2` retrieved chunks under `cross_tenant_filter_omission`, whereas `Native + Vervain` withholds foreign `beacon/strategy-note-v2` (`tenant_mismatch`), seals `1 of 2` authorized chunks in `VERIFIED_ADMITTED_CHUNKS` (`WeakSet`), calls official `@google/genai` server-side (`src/server/gemini.ts`), rechecks live `policyEpoch` + `allowedSourceIds` + exact planted-value absence at `ResponseReleaseGate` (`src/server/release.ts`), and commits a content-free SHA-256 hash-chained `ContextReceipt` (`src/server/ledger.ts`, `src/server/receipts.ts`).
2. **Dark Aperture Workspace & Isometric 3D Memory-Cube Lineage (`src/client/`):**
   - Signature `#0a0a0b` obsidian + `#9b8af5` violet single-page workspace (`1440x900` judge laptop layout above the fold).
   - `ProvenanceGraph.tsx` + `CausalReplayScrubber.tsx`: Isometric 3D wire-cube memory volume (`AUDIT · ALERT · GOVERN`) with `pre-inference cut-plane`, `6`-stage interactive scrubber, and `5`-question CISO governance strip (`WHO`, `WHAT`, `WHEN`, `HOW`, `WHY`).
   - `EnterpriseArchitectureStrip.tsx`: Post-IAM / Pre-Egress inference thesis (`1/3` open-weight token reality) across `4` enterprise presets and `5` engine profiles (`vLLM`, `SGLang`, `Ollama`, `NVIDIA Dynamo`, `Google Gemini`).
3. **Open-Weight 4-Mode KV Workbench, Carbon 3 Verifier Seam & Carbon 4 9-Step Replay:**
   - `src/server/open-weight-workbench.ts`: `4` deterministic KV failure/remediation modes (`contaminated_block_table`, HMAC `cache_salt` `prefix_cache_hash_collision`, `stale_allocation_generation` ABA check, and Proxy-verified zero-KV-read `online_tiled_flash_recurrence` within `<= 1e-12`).
   - `src/server/inference-proof.ts` + `packages/evidence-verifier/`: Dual TypeScript + Python RFC 8259/8785 JCS SHA-256 and zero-echo `inference-proof.v1` verifier (`NO GPU RUN RECORDED` by default; `runtimeManifest: null` enforced on all non-`PASS` verdicts).
   - `packages/judge-replay/` mounted inside `ScopedAttentionLab.tsx`: Interactive `9`-step self-hosted `vLLM` Birch/Alder Paged-KV Attention Aperture replay across `5` pre-GPU fixtures (`local-paired`, `awaiting-h200`, `unsupported-backend`, `verifier-failed`, `stale-epoch`).

---

## 3. Complete Local Verification Gate Commands

Run from `/Users/pjmullin/Desktop/vervain-carbon-demo`:

```bash
npm run typecheck          # Strict tsc across client, shared, server, scripts, tests, and embedded judge-replay
npm run lint               # ESLint verification across src and tests
npm test                   # 105 deterministic unit, integration, and 8-cycle adversarial Vitest tests
npm run build              # Vite client bundle (dist/client) + server compile (dist/server)
npm run verify:bundle      # Verifies 0 API keys, .env files, or @google/genai imports in dist/client
npm run verify:claims      # Verifies 0 prohibited overclaims, 0 em dashes, and required limitation banners (37 files)
npm run verify:evidence    # Carbon 3 Python + TS verifier gates (40 pytest checks, 35 JSON fixtures, 7 RUN_DIRs)
npm run proof:paired       # Terminal JSON paired-proof summary (Native only vs Native + Vervain)
npm run test:e2e           # Playwright clean-browser E2E suite (1440x900, 1280x800, 390x844, reduced motion)
npm audit --audit-level=high
```

---

## 4. Daytime Operator Runbook (Post-10:00 AM PT & Explicit Owner Authorization)

### Step A: Live Google Gemini Smoke Test & Cloud Run Deployment (Requires Owner `GEMINI_API_KEY` + GCP Project)

```bash
# 1. Local live Gemini SDK smoke check
GEMINI_API_KEY="<PROJECT_KEY>" GEMINI_MODEL="gemini-2.5-flash" npm run test:live

# 2. Deploy single-origin container to Google Cloud Run
gcloud run deploy vervain-context-firewall \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars="NODE_ENV=production,DEMO_MODE=live,GEMINI_MODEL=gemini-2.5-flash,MAX_GEMINI_CALLS_PER_SESSION=12,MAX_GEMINI_CALLS_PER_WINDOW=60,RATE_LIMIT_MUTATIONS_PER_MINUTE=20" \
  --set-secrets="GEMINI_API_KEY=GEMINI_API_KEY:latest,SESSION_SECRET=SESSION_SECRET:latest"
```

### Step B: Post-`GPU GO` Carbon 2 H200 Artifact Verification & Attachment (Only After PJ Sends `GPU GO`)

1. Once Builder 2 (`carbon/scoped-attention`) records an authorized H200 `RUN_DIR` after `10:00 AM PT` + explicit `GPU GO`, verify the `RUN_DIR` offline with Carbon 3's verifier:
   ```bash
   bash verification/verify_h200_run.sh <RUN_DIR> \
     --trust-root <REAL_TRUST_ROOT_JSON> \
     --require-signature \
     --out-dir /tmp/vervain_h200_verified
   ```
2. If and only if `verification.json` reports `verdict: "PASS"`, attach the verified `artifact.json` to the web server:
   ```bash
   INFERENCE_PROOF_ARTIFACT_PATH="<VERIFIED_ARTIFACT_JSON>" \
   EVIDENCE_VERIFIER_PYTHONPATH="packages/evidence-verifier/src" \
   INFERENCE_PROOF_TRUST_ROOT_PATH="<REAL_TRUST_ROOT_JSON>" \
   INFERENCE_PROOF_REQUIRE_SIGNATURE="1" \
   npm start
   ```
3. Update Tier 3 and Tier 4 rows in `CLAIMS.md` and `BUILD_PROOF.md` with the observed live `GEMINI_MODEL` latency, Cloud Run URL, and verified H200 `run_id` / `artifact_sha256`.
