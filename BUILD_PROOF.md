# Build Provenance (`BUILD_PROOF.md`)

This document records verifiable build provenance for **Vervain Context Firewall** in the fresh hackathon repository. No provenance field is fabricated; fields awaiting external hackathon credentials or public hosting are marked explicitly.

## Generation Environment and Timeline

| Field | Value |
|---|---|
| Repository path | `/Users/pjmullin/Desktop/vervain-carbon-demo` |
| Initial empty workspace commit | `195dffab5425baf1d58cffdb0b9fd3d00b606f0e` (`2026-11-14T03:24:10-08:00`) |
| Builder harness | Google Antigravity CLI (`conversation://7fa3bbaa-43b7-4edf-827a-a52efebe161f`) |
| Transcript path (local operator host) | `/Users/pjmullin/.gemini/antigravity-cli/brain/7fa3bbaa-43b7-4edf-827a-a52efebe161f/.system_generated/logs/transcript.jsonl` |
| Builder model | Gemini 4 Carbon (High) |
| Build start timestamp | `2026-11-14T03:42:38-08:00` |
| Host runtime | Node.js `v26.11.1`, npm `11.20.0`, Git `2.39.5` (macOS) |
| Container target runtime | Node.js `22-bookworm-slim` (`PORT=8080`, Cloud Run single-service contract) |
| AI Studio share link | `PENDING OWNER ACTION - paste AI Studio share link when temporary hackathon account is attached` |
| Google Cloud project ID | `berkeleygdm26oak-7315` (`us-central1`) |
| Live Gemini model configured | `gemini-4-carbon` via official `@google/genai` server SDK (`DEMO_MODE=live`) |
| Public Cloud Run / hosted URL | `https://vervain-context-firewall-932365121699.us-central1.run.app` (alias `https://vervain-context-firewall-m6xhca334q-uc.a.run.app`) |
| Cloud Run revision & source SHA | `vervain-context-firewall-00001-m5g` built from `d5b1b91f2e2f6968da64317fe74640cdf8b3124e` (`--max-instances 1`) |
| Live smoke & hosted verification UTC | Live smoke `2026-11-14T19:48:41Z` to `19:49:40Z`; local prod `2026-11-14T19:51:04Z`; hosted Playwright E2E `2026-11-14T20:08:03Z` |

## Clean-Room Boundary Statement

- Prior private repository (`pjmullin3/vervain`, local read-only checkout commit `8d530813d81323b159dbadab4cd3084648381d14` dated `2026-09-30`) remained outside this repository.
- No Python source files, bundled JSX/JavaScript assets, CSS stylesheets, logos, screenshots, tests, or Git commits were copied from the prior checkout.
- Conceptual lineage from `03-PITCH-AND-REPO-GROUNDING.md` is mapped item-by-item in `ORIGIN_MAP.md`.

## Architecture Decision Record (M0)

- **Stack**: Single-service full-stack TypeScript application (`@google/genai` on a `node:http` server + React 19 / Vite 8 client bundle).
- **Package manager**: `npm` (`package.json` + `package-lock.json`) for zero-friction compatibility with Cloud Run source deploys, Docker `node:22-bookworm-slim`, and AI Studio exports.
- **Why `node:http` without heavy web middleware**: Direct access to `req.rawHeaders` (duplicate header rejection), raw request byte buffers (strict byte-size enforcement and custom RFC 8259 duplicate-JSON-key / prototype-key rejection prior to object materialization), minimal production dependency footprint (`@google/genai`, `react`, `react-dom`), and deterministic in-process testing.
- **Persistence boundary**: Bounded in-memory session and append-only ledger stores keyed by opaque server-owned session IDs. Instance restarts clear synthetic history; receipt hash chains are tamper-evident within a running instance and explicitly do not detect full-store rollback without an external checkpoint.

## Milestone Log

- **M0 (`2026-11-14T03:46-08:00`, base `195dffab`)**: Initialized `BUILD_PROOF.md`, `ORIGIN_MAP.md`, `RESEARCH.md`, `.env.example`, and TypeScript/Vite/Vitest/Playwright/ESLint configuration.
- **M1-M3 (`2026-11-14T04:08-08:00`, commit `fe54534`)**: Implemented deterministic server session authority (`SessionStore`), tenant-scoped and synthetic defective retrievers, 6-step pre-inference admission gate (`VERIFIED_ADMITTED_CHUNKS` `WeakSet`), official `@google/genai` server adapter, nonstreaming response release gate, content-free SHA-256 event/receipt hash chain, and Scoped Attention reference math.
- **M4-M6 + Security Cycles 1-7 (`2026-11-14T04:49-08:00`, commit `517aa6e`)**: Delivered Dark Aperture React 19 UI, paired lanes, Cloud Run `Dockerfile`, pitch/architecture/threat/claim docs, Playwright E2E suite, and adversarial red-team Cycles 1 through 7 (`73/73` Vitest tests passing).
- **Wave 2 + Wave 3 Open-Weight KV Workbench, Isometric Memory-Cube Lineage & Cycle 8 Hardening (`2026-11-14T05:35-08:00`, commit `4d24aa0`)**: Added isometric 3D wire-cube memory volume with `pre-inference cut-plane`, 6-stage Causal Replay Scrubber, 5-question CISO governance strip, Post-IAM / Pre-Egress Enterprise Architecture Strip (`4` presets, `5` engine profiles), 4-mode Open-Weight KV Lifecycle Explorer (`contaminated_block_table`, HMAC `cache_salt` `prefix_cache_hash_collision`, `stale_allocation_generation` ABA check, and Proxy zero-read `online_tiled_flash_recurrence`), Carbon 3 `inference-proof.v1` JCS SHA-256 + zero-echo verifier seam (`NO GPU RUN RECORDED` prior to `GPU GO`), `EXECUTIVE_ENTERPRISE_BRIEF.md`, `DAYBREAK_SECURITY_REPORT.md`, and Cycle 8 red-team remediations (`105/105` Vitest tests + `2/2` Playwright E2E tests passing).
- **Swarm Integration: Carbon 3 Evidence Verifier & Carbon 4 Judge Causal Replay (`2026-11-14T05:56-08:00`)**: Integrated Carbon 3 (`packages/evidence-verifier/`, `schemas/verification/`, `verification/`, `npm run verify:evidence` with `40/40` Python + TS differential pytest checks passing) and Carbon 4 (`packages/judge-replay/`, `fixtures/judge-replay/`, `docs/judge-replay/`, mounted inside `ScopedAttentionLab.tsx` across `5` pre-GPU fixtures with `NO GPU RUN RECORDED`), documented in `CARBON1_HANDOFF.md` and `CARBON1_HANDOFF.json`.
- **Live Gemini Smoke, Local Production Run & Cloud Run Deployment (`2026-11-14T19:48Z` to `20:08Z`, source commit `d5b1b91f2e2f6968da64317fe74640cdf8b3124e`, harness `conversation://6d54a80f-d7dd-48b5-bfc3-1490508dcd6e`)**:
  - **Live Gemini smoke (`2026-11-14T19:48:41Z` to `19:49:40Z`, model `gemini-4-carbon`)**: `ALLOW_LIVE_GEMINI=1 npm run test:live` passed (`1/1`, `10979ms`). Content-free paired telemetry recorded `Native only` (`req_ctrl_9271c91748e273cbc4e0`, `rcpt_8952aa294e3889f716b5d072`) transmitting `2` of `2` retrieved chunks (`cross_tenant_context_transmitted`, `8515ms`, `0` retries, `invalid_response` under `256`-token cap) and `Native + Vervain` (`req_vvn_1f1d3e2e07817d3166e3`, `rcpt_309663a6e95707768deef736`) withholding `1` of `2` foreign chunks before Gemini (`foreign_context_withheld_before_gemini`, `4361ms`, `0` retries, `providerOutcome: "succeeded"`, `releaseDecision: "released"`, `permittedTaskCompleted: true`, ledger `12` events / `2` receipts verified).
  - **Local production verification (`2026-11-14T19:51:04Z`, `PORT=8090`)**: Verified `/healthz` (`200`) and `/readyz` (`200`, `live`), executed `2` paired API runs via `__Host-vervain_cf_sid` cookie (`Native + Vervain` `succeeded` in `4719ms` and `6143ms`, `0` retries; `Native only` `cross_tenant_context_transmitted` in `5160ms` and `6707ms`, `0` retries), verified `/api/ledger/verify` (`24` events, `4` receipts), and stopped port `8090`.
  - **Cloud Run deploy & clean-browser Playwright verification (`2026-11-14T20:08:03Z`)**: Deployed `vervain-context-firewall` to `us-central1` (`--max-instances 1`, Secret Manager `GEMINI_API_KEY` and `SESSION_SECRET`) at `https://vervain-context-firewall-932365121699.us-central1.run.app`, revision `vervain-context-firewall-00001-m5g`. Fresh Chromium contexts at `1440x900` and `390x844` verified header `gemini-4-carbon LIVE SDK`, paired proof, chain verification (`84` events / `14` receipts), receipt export (`200`), causal + vLLM replay, session reset, and paired rerun (`0` occurrences of `AIza` or `BEACON_PROJECT_EMBER_742` across the JS bundle and `28` of `28` scanned network responses; `12` screenshots saved under gitignored `test-results/hosted/`).
