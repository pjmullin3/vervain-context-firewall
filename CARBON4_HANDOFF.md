# Carbon 4 Handoff: Vervain Judge-Facing Causal Replay (`@vervain/judge-replay`)

## 1. Branch, Commit & Build Provenance

- **Worktree**: `/Users/pjmullin/Desktop/vervain-carbon-experience-lane`
- **Branch**: `carbon/experience` (committed locally; **not merged**)
- **Base Commit SHA**: `805ce37176d459d771436a05823984fe1b73980a`
- **Implementation Commit SHA**: `339b07ffbcacd50c97f779c8ebf52113e76e7dfa`
- **Handoff Commit**: Final commit on `carbon/experience` adding `CARBON4_HANDOFF.md` and `HANDOFF.json` directly atop `339b07ffbcacd50c97f779c8ebf52113e76e7dfa`
- **Antigravity Session / Build Proof**: `conversation://3c2dbe16-a3a5-4a62-a3b0-f3470e61d420` (transcript at `/Users/pjmullin/.gemini/antigravity-cli/brain/3c2dbe16-a3a5-4a62-a3b0-f3470e61d420/.system_generated/logs/transcript.jsonl`)
- **Hard Compute Hold Compliance**: Zero GPU, cluster, pod, remote host, or paid compute connections were attempted or configured. Every pre-GPU fixture explicitly displays `NO GPU RUN RECORDED` with `gpu_run_recorded: false`.
- **Owned Paths Touched Only**:
  - `packages/judge-replay/`
  - `fixtures/judge-replay/`
  - `docs/judge-replay/`
  - `CARBON4_HANDOFF.md`
  - `HANDOFF.json`

---

## 2. Package API & Entrypoints

Package name: `@vervain/judge-replay` (`0.1.0`, ESM + TypeScript declarations, **zero runtime dependencies**).

| Subpath Export | Purpose |
| --- | --- |
| `@vervain/judge-replay` | Full React + TypeScript package (`VervainInferenceReplay`, `ReceiptDrawer`, parser, state machine, summary generator, fixture loader, CSS token map, idempotent style helper) |
| `@vervain/judge-replay/core` | Framework-neutral TypeScript core (schema types, `parseEvidenceBundle`, `validateEvidenceBundle`, `createReplayState`, `replayReducer`, `generateCausalSummary`, `loadSafeFixture`, `resolveDeepLinkSelection`, `VERVAIN_CSS_TOKENS`) |
| `@vervain/judge-replay/tokens.css` | Standalone CSS custom properties (`--vr-*`) |
| `@vervain/judge-replay/styles.css` | Component, responsive, focus, and `prefers-reduced-motion` stylesheet (also idempotently auto-injected at mount so lead integration never breaks if CSS bundler config differs) |

### Exported Symbols

- **Evidence Schema & Types**: `EVIDENCE_SCHEMA_VERSION` (`"vervain.judge_replay.v1"`), `CANONICAL_TIMELINE_STEPS`, `EvidenceBundle`, `ValidatedEvidenceBundle`, `ParseEvidenceResult`, `SourceStatus`, `SourceBadgeLabel`, `VerifierVerdict`, `EvidenceFreshness`, `LaneId`, `TimelineStepIndex`, `StepDisposition`, `LineageItem`, `PhysicalBlockEvidence`, `TimelineStepEvidence`, `LaneReplayEvidence`, `SampledCountRatioMetric`, `SampledDistributionMetric`, `SampledScalarMetric`, `PerformanceOverheadMetrics`, `PairedConfigurationCheck`, `ValidationErrorItem`
- **Parser & Untrusted Input Validation**: `parseEvidenceBundle`, `validateEvidenceBundle`, `checkPairedConfiguration`, `canRenderOutcomeClaim`, `mapSourceStatusToBadge`, `escapeHtml`, `scanUntrustedGraph`, `sanitizeIdentifier`, `deepFreeze`
- **Deterministic Replay State Machine**: `createReplayState`, `replayReducer`, `DEMO_STEP_INTERVAL_MS`, `ReplayState`, `ReplayEvent`, `ReplaySurfaceKind`, `CreateReplayStateOptions`
- **React Components**: `VervainInferenceReplay` (`VervainInferenceReplayProps`), `ReceiptDrawer` (`ReceiptDrawerProps`)
- **Text Summary & Denominator Formatters**: `generateCausalSummary`, `formatCountRatioMetric`, `formatPercentileMetric`, `formatScalarMetric`
- **Design Tokens & Styles**: `VERVAIN_CSS_TOKENS`, `toCssCustomPropertyBlock`, `VERVAIN_EMBEDDED_CSS`, `ensureStylesInjected`
- **Safe Fixture Loader & Deep-Link Allowlist**: `loadSafeFixture`, `createSafeFixtureRegistry`, `resolveDeepLinkSelection` (`SafeFixtureRegistry`, `DeepLinkSelection`)
- **Copy Contract**: `COPY_CONTRACT`, `BANNED_UNBOUNDED_CLAIMS`, `containsBannedUnboundedClaim`

---

## 3. Required Peer Dependencies

```json
{
  "peerDependencies": {
    "react": "^18.2.0 || ^19.0.0",
    "react-dom": "^18.2.0 || ^19.0.0"
  }
}
```

Runtime `dependencies`: `{}` (none). No private fonts, logos, binary images, or external network requests are used.

---

## 4. Install, Build, Test & Preview Commands

Run from worktree root (`/Users/pjmullin/Desktop/vervain-carbon-experience-lane`):

```bash
# Install deterministic lockfile dependencies
npm --prefix packages/judge-replay ci

# Run all local gates (typecheck + lint + unit/component tests + Playwright E2E + package build + demo build + security/audit scan)
npm --prefix packages/judge-replay run verify

# Individual gates
npm --prefix packages/judge-replay run typecheck
npm --prefix packages/judge-replay run lint
npm --prefix packages/judge-replay test
npm --prefix packages/judge-replay run test:e2e
npm --prefix packages/judge-replay run build
npm --prefix packages/judge-replay run build:demo
npm --prefix packages/judge-replay run scan:security

# Local interactive preview for judges or lead integration check
npm --prefix packages/judge-replay run dev
```

### Screenshot Generation

To regenerate deterministic full-page desktop (`1440px`), baseline differential, receipt drawer, narrow mobile (`360px`), and `verifier-failed` PNG screenshots:

```bash
QA_SCREENSHOT_DIR=/tmp/vervain-replay-qa npm --prefix packages/judge-replay run test:e2e
```

---

## 5. Lead App Integration Snippet

```tsx
import React from "react";
import {
  VervainInferenceReplay,
  createSafeFixtureRegistry,
  resolveDeepLinkSelection
} from "@vervain/judge-replay";
import "@vervain/judge-replay/tokens.css";
import "@vervain/judge-replay/styles.css";

import localPairedJson from "../../fixtures/judge-replay/local-paired-replay.json";
import awaitingH200Json from "../../fixtures/judge-replay/awaiting-h200-incomplete.json";

const registry = createSafeFixtureRegistry({
  "local-paired": localPairedJson,
  "awaiting-h200": awaitingH200Json
});

export function JudgeReplaySection(): React.JSX.Element {
  const deepLink = resolveDeepLinkSelection(
    typeof window !== "undefined" ? window.location.search : "",
    registry.aliases,
    "local-paired"
  );

  // Pass raw JSON or live H200 receipt payload directly; VervainInferenceReplay
  // validates schema, rejects live labels on fixtures, and preserves object identity across mode switches.
  const activePayload = registry.getRaw(deepLink.runAlias ?? "local-paired");

  return (
    <VervainInferenceReplay
      evidence={activePayload}
      initialLane={deepLink.lane}
      initialStepIndex={deepLink.stepIndex}
      initialReceiptOpen={deepLink.receiptOpen}
      rejectedDeepLinkParams={deepLink.rejectedParams}
    />
  );
}
```

When a verified H200 artifact is produced after PJ's `GPU GO`, pass the parsed JSON artifact via `evidence={h200Artifact}` (not `loadSafeFixture`, which intentionally blocks `"source_status": "live"` on static fixtures).

---

## 6. Fixture Statuses (Pre-GPU Honesty Audit)

All 5 fixtures under `fixtures/judge-replay/` pass schema validation (`loadSafeFixture` where expected, or intentional digest mismatch for `verifier-failed-digest.json`), set `"gpu_run_recorded": false`, include `"NO GPU RUN RECORDED"`, and carry **zero** `live` or `recorded` H200 labels:

| Fixture Path | Safe Alias | `source_status` | Badge | `verifier.verdict` | Purpose |
| --- | --- | --- | --- | --- | --- |
| `fixtures/judge-replay/local-paired-replay.json` | `local-paired` | `local_only` | `LOCAL TEST` + `NO GPU RUN RECORDED` | `verified` | Full 9-step paired deterministic local contract harness (`Native only` vs `Native plus Vervain`) |
| `fixtures/judge-replay/awaiting-h200-incomplete.json` | `awaiting-h200` | `incomplete` | `INCOMPLETE` + `NO GPU RUN RECORDED` | `unverified` | Steps 1..3 recorded; steps 4..9 unrecorded prior to H200 window; Demo auto-stops at Step 3 |
| `fixtures/judge-replay/unsupported-backend.json` | `unsupported-backend` | `unsupported` | `UNSUPPORTED` + `NO GPU RUN RECORDED` | `unverified` | Runtime selected unmediated fallback backend; outcome claim withheld |
| `fixtures/judge-replay/verifier-failed-digest.json` | `verifier-failed` | `local_only` | `LOCAL TEST` + `[!] VERIFIER FAILED` | `failed` | Canonical vs computed SHA-256 mismatch; renders prominent verification failure and withholds outcome line |
| `fixtures/judge-replay/stale-policy-epoch.json` | `stale-epoch` | `local_only` | `LOCAL TEST` + `NO GPU RUN RECORDED` | `verified` | `freshness: "stale"`; displays stale policy-epoch banner and withholds outcome claim |

---

## 7. Accessibility & Responsive Verification

Verified via automated Vitest + Testing Library tests (`22 passed`) and real Google Chrome Playwright E2E checks (`4 passed`):

- **WCAG AA Contrast**: Computed luminance contrast verified `>= 4.5:1` across primary heading, technical copy, outcome copy, full-size limit copy (`>= 15px`), status badges, active step detail, and metadata keys.
- **Zero Color-Only Status**:
  - `scope:birch` (request owner): solid circle `●`, horizontal-rule SVG pattern, solid border, explicit `scope:birch` text label.
  - `scope:alder` (foreign injected): diamond `◆`, diagonal-hatch SVG pattern, chamfered octagon geometry, explicit `scope:alder` text label.
  - Attention read aperture: isometric cut-plane with orthogonal stop symbol `┤ CLIPPED` vs dashed `OPEN` slit.
  - Verifier / source badges: paired icon glyph (`✓`, `△`, `◇`, `[!]`), border style (solid vs dashed vs double-weight alert), and uppercase text label.
- **Full Keyboard Operation**: `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown`, `Home`, and `End` scrub and move focus across the 9 timeline steps; `Enter`/`Space` activate stage readouts and controls; `Escape` closes `ReceiptDrawer` and restores focus to the exact opener button.
- **Visible Focus**: High-contrast `:focus-visible` outline (`2px solid #a88eff`, `2px` offset) across all buttons, timeline steps, and disclosure summaries.
- **Reduced Motion**: `@media (prefers-reduced-motion: reduce)` sets carrier and drawer `transition-duration: 0s` (verified in Playwright with `emulateMedia({ reducedMotion: "reduce" })`), switching cleanly between discrete states without loss of meaning. Zero ambient or text-background animations exist in any mode.
- **Screen-Reader Semantics**: `<header>`, `<main>`, `<aside role="dialog">`, hierarchical headings, descriptive `aria-label` on SVG and stage buttons, polite live region (`role="status"`) limited to meaningful step/lane changes, and full plain-text causal summary from `generateCausalSummary`.
- **Responsive Range**: Verified zero horizontal overflow (`scrollWidth <= innerWidth`) at `360x840` narrow mobile, `1440x980` desktop poster, and `1920x1080` presentation screen.

---

## 8. Claim & Evidence Boundaries

- **Locked Primary Line**: `IAM ends at access. Vervain keeps identity attached through model memory.`
- **Locked Technical Line**: `A server-owned scope follows each request into vLLM. Before the selected attention backend reads paged KV, Vervain compares the request scope with physical block ownership and allocation generation.`
- **Conditional Outcome Line** (rendered **only** when `canRenderOutcomeClaim` confirms verified digest, non-stale freshness, `local_only`/`recorded`/`live` status, matching paired lane config, foreign block stopped in `native_plus_vervain`, foreign block dispatched in `native_only`, and allowed Birch completion): `Foreign block stopped before backend dispatch. Allowed request completed.`
- **Full-Size Limit Line** (displayed beside the outcome at `0.9375rem` / `15px`, never in tiny print, plus full-size section at the top of `ReceiptDrawer`): `Controlled internal fault injection on the named configuration. Other backends and provider-internal memory are not mediated.`
- **Untrusted Evidence Rejection**: `parseEvidenceBundle` rejects `NaN`, `Infinity`, negative counts, `numerator > denominator`, `p50 > p95`, overlong strings/arrays, non-contiguous recorded steps, and any payload key or value resembling a raw prompt, planted value, protected output, KV tensor, secret, credential, token, email, URL, or IP address.
- **Public Control Lockdown**: UI exposes only `Demo`, `Pause`, `Step`, `Restart`, `Native only`, `Native plus Vervain`, timeline step `1..9`, and `Open exact receipt`. Mode switching never mutates the evidence bundle reference (`Object.is` verified). Deep links accept only safe `run`, `step`, `lane`, and `receipt` aliases.

---

## 9. Dependency & Secret-Scan Result

Executed via `npm --prefix packages/judge-replay run scan:security`:

- `npm audit --audit-level=low`: **0 vulnerabilities**
- Secret patterns scanned (PEM keys, AWS keys, GitHub tokens, `sk-*` keys, Slack tokens, JWTs): **0 matches**
- Forbidden binary/private asset files (`.png`, `.jpg`, `.svg` external logos, `.woff2`, etc.): **0 files**
- Network egress APIs (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`) in `src/`: **0 calls**
- Em-dash (`\u2014`) check across code, fixtures, docs, and handoff: **0 matches**
- Unbounded overclaim scan across `src/`, `demo/`, and `fixtures/`: **0 matches**
- Pre-GPU fixture audit (`NO GPU RUN RECORDED` + `gpu_run_recorded: false` + no `live`/`recorded` status): **5 / 5 passed**

---

## 10. Committed File Inventory (47 Owned Files)

1. `CARBON4_HANDOFF.md`
2. `HANDOFF.json`
3. `docs/judge-replay/README.md`
4. `docs/judge-replay/accessibility-and-claims.md`
5. `docs/judge-replay/evidence-contract.md`
6. `fixtures/judge-replay/awaiting-h200-incomplete.json`
7. `fixtures/judge-replay/local-paired-replay.json`
8. `fixtures/judge-replay/stale-policy-epoch.json`
9. `fixtures/judge-replay/unsupported-backend.json`
10. `fixtures/judge-replay/verifier-failed-digest.json`
11. `packages/judge-replay/demo/App.tsx`
12. `packages/judge-replay/demo/main.tsx`
13. `packages/judge-replay/eslint.config.mjs`
14. `packages/judge-replay/index.html`
15. `packages/judge-replay/package-lock.json`
16. `packages/judge-replay/package.json`
17. `packages/judge-replay/playwright.config.ts`
18. `packages/judge-replay/scripts/build.mjs`
19. `packages/judge-replay/scripts/security-scan.mjs`
20. `packages/judge-replay/src/components/CausalFieldSvg.tsx`
21. `packages/judge-replay/src/components/PairedComparison.tsx`
22. `packages/judge-replay/src/components/ReceiptDrawer.tsx`
23. `packages/judge-replay/src/components/TimelineScrubber.tsx`
24. `packages/judge-replay/src/components/TopStatusStrip.tsx`
25. `packages/judge-replay/src/components/VervainInferenceReplay.tsx`
26. `packages/judge-replay/src/copyContract.ts`
27. `packages/judge-replay/src/core.ts`
28. `packages/judge-replay/src/fixtures.ts`
29. `packages/judge-replay/src/index.ts`
30. `packages/judge-replay/src/machine.ts`
31. `packages/judge-replay/src/parser.ts`
32. `packages/judge-replay/src/sanitize.ts`
33. `packages/judge-replay/src/styles/replay.css`
34. `packages/judge-replay/src/styles/styleSheet.ts`
35. `packages/judge-replay/src/styles/tokens.css`
36. `packages/judge-replay/src/summary.ts`
37. `packages/judge-replay/src/tokens.ts`
38. `packages/judge-replay/src/types.ts`
39. `packages/judge-replay/tests/e2e/replay.spec.ts`
40. `packages/judge-replay/tests/package-exports.test.ts`
41. `packages/judge-replay/tests/parser-and-machine.test.ts`
42. `packages/judge-replay/tests/replay-component.test.tsx`
43. `packages/judge-replay/tests/setup.ts`
44. `packages/judge-replay/tsconfig.build.json`
45. `packages/judge-replay/tsconfig.json`
46. `packages/judge-replay/vite.config.ts`
47. `packages/judge-replay/vitest.config.ts`
