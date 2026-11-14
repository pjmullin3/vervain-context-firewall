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
| Google Cloud project ID | `PENDING OWNER ACTION - configure hackathon project (e.g. berkeleygdm26oak-7315)` |
| Live Gemini model configured | Configurable via `GEMINI_MODEL` (default `gemini-2.5-flash`) through official `@google/genai` server SDK |
| Public Cloud Run / hosted URL | `PENDING OWNER DEPLOYMENT - requires gcloud auth login + GEMINI_API_KEY in target project` |

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
- **Wave 2 + Wave 3 Open-Weight KV Workbench, Isometric Memory-Cube Lineage & Cycle 8 Hardening (`2026-11-14T05:35-08:00`)**: Added isometric 3D wire-cube memory volume with `pre-inference cut-plane`, 6-stage Causal Replay Scrubber, 5-question CISO governance strip, Post-IAM / Pre-Egress Enterprise Architecture Strip (`4` presets, `5` engine profiles), 4-mode Open-Weight KV Lifecycle Explorer (`contaminated_block_table`, HMAC `cache_salt` `prefix_cache_hash_collision`, `stale_allocation_generation` ABA check, and Proxy zero-read `online_tiled_flash_recurrence`), Carbon 3 `inference-proof.v1` JCS SHA-256 + zero-echo verifier seam (`NO GPU RUN RECORDED` prior to `GPU GO`), `EXECUTIVE_ENTERPRISE_BRIEF.md`, `DAYBREAK_SECURITY_REPORT.md`, and Cycle 8 red-team remediations (`105/105` Vitest tests + `2/2` Playwright E2E tests passing).
