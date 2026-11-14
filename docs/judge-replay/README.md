# `@vervain/judge-replay`

Judge-facing causal inference replay and cryptographic receipt inspector for the Vervain scoped KV firewall.

## Purpose

In sixty seconds, without narration, this workspace shows one continuous causal trace:

1. IAM authenticates and allows a Birch request (`scope:birch`).
2. Controlled internal fault injection omits a retrieval tenant predicate, placing an Alder record (`scope:alder`) onto Birch's context path.
3. Vervain keeps scope identity attached as text converts into logical tokens and physical paged KV blocks.
4. The foreign physical block reaches the final pre-attention read aperture.
5. In the `Native only` baseline lane, the unmediated block table reaches backend dispatch.
6. In the `Native plus Vervain` lane, the attention read aperture compares request scope against physical block ownership and allocation generation, stopping the foreign block before backend dispatch.
7. An uncontaminated Birch request (`scope:birch`) still dispatches and completes.
8. Exact software SHAs, patch digest, runtime-selected backend, GPU topology (or `NO GPU RUN RECORDED`), sample-count denominators, and stated exclusions are one click away in the receipt drawer.

## Quick Integration

```tsx
import { VervainInferenceReplay } from "@vervain/judge-replay";
import "@vervain/judge-replay/tokens.css";
import "@vervain/judge-replay/styles.css";

export function JudgeReplaySection({ rawArtifact }: { rawArtifact: unknown }) {
  return (
    <VervainInferenceReplay
      evidence={rawArtifact}
      status="loaded"
      initialLane="native_plus_vervain"
    />
  );
}
```

Note: `VervainInferenceReplay` and `ReceiptDrawer` also idempotently inject their scoped stylesheet on mount (`injectStyles={true}` by default), so rendering works even if the host bundler does not import `@vervain/judge-replay/styles.css`.

## Public Exports

From `@vervain/judge-replay`:

- **Schema & types**: `EVIDENCE_SCHEMA_VERSION`, `CANONICAL_TIMELINE_STEPS`, `EvidenceBundle`, `ValidatedEvidenceBundle`, `ParseEvidenceResult`, `ValidationIssue`, `SourceStatus`, `LaneId`, `TimelineStepIndex`, `TimelineStepId`
- **Parser & validator**: `parseEvidenceBundle`, `validateEvidenceBundle`, `checkPairedConfiguration`, `canRenderOutcomeClaim`, `mapSourceStatusToBadge`
- **Replay state machine**: `createReplayState`, `replayReducer`, `computeMaxRecordedStepIndex`, `classifySurfaceKind`
- **Safe fixture & deep-link helpers**: `loadSafeFixture`, `createSafeFixtureRegistry`, `resolveDeepLinkSelection`
- **Text summary generator**: `generateCausalSummary`, `formatCountRatioMetric`, `formatPercentileMetric`, `formatScalarMetric`
- **Design tokens**: `VERVAIN_REPLAY_TOKENS`, `VERVAIN_REPLAY_TOKENS_CSS` (plus `@vervain/judge-replay/tokens.css`)
- **React components**: `VervainInferenceReplay`, `ReceiptDrawer`

Framework-neutral TypeScript consumers (such as Node scripts or server tests) can import `@vervain/judge-replay/core` without pulling in React.

## Local Preview & Verification Commands

Run from `packages/judge-replay`:

```bash
npm install
npm run verify      # typecheck + lint + unit/component + Playwright E2E + build + demo build + security scan
npm run dev         # launches standalone preview at http://127.0.0.1:4179
```

Safe preview deep links:

- `http://127.0.0.1:4179/?run=local-paired`
- `http://127.0.0.1:4179/?run=local-paired&lane=native&step=backend-dispatched-or-stopped`
- `http://127.0.0.1:4179/?run=local-paired&receipt=open`
- `http://127.0.0.1:4179/?run=awaiting-h200`
- `http://127.0.0.1:4179/?run=unsupported-backend`
- `http://127.0.0.1:4179/?run=verifier-failed`
- `http://127.0.0.1:4179/?run=stale-epoch`
