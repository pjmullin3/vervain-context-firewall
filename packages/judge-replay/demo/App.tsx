import React, { useState } from "react";
import localPairedFixture from "../../../fixtures/judge-replay/local-paired-replay.json";
import awaitingH200Fixture from "../../../fixtures/judge-replay/awaiting-h200-incomplete.json";
import unsupportedBackendFixture from "../../../fixtures/judge-replay/unsupported-backend.json";
import verifierFailedFixture from "../../../fixtures/judge-replay/verifier-failed-digest.json";
import staleEpochFixture from "../../../fixtures/judge-replay/stale-policy-epoch.json";
import {
  VervainInferenceReplay,
  createSafeFixtureRegistry,
  resolveDeepLinkSelection
} from "../src/index.js";

const DEMO_RUN_ALIASES = [
  "local-paired",
  "awaiting-h200",
  "unsupported-backend",
  "verifier-failed",
  "stale-epoch",
  "invalid-sample",
  "empty-sample",
  "loading-sample"
] as const;

type DemoRunAlias = (typeof DEMO_RUN_ALIASES)[number];

const FIXTURE_REGISTRY = createSafeFixtureRegistry({
  "local-paired": localPairedFixture,
  "awaiting-h200": awaitingH200Fixture,
  "unsupported-backend": unsupportedBackendFixture,
  "verifier-failed": verifierFailedFixture,
  "stale-epoch": staleEpochFixture
});

const INTENTIONALLY_INVALID_SAMPLE = Object.freeze({
  schema_version: "vervain.judge_replay.v1",
  source_status: "local_only",
  gpu_run_recorded: false,
  gpu_status_label: "NO GPU RUN RECORDED",
  unexpected_untrusted_key: "rejected_by_strict_schema"
});

const ALIAS_LABELS: Readonly<Record<DemoRunAlias, string>> = {
  "local-paired": "Local test (paired)",
  "awaiting-h200": "Incomplete (awaiting H200)",
  "unsupported-backend": "Unsupported backend",
  "verifier-failed": "Verifier failed",
  "stale-epoch": "Stale epoch",
  "invalid-sample": "Invalid schema",
  "empty-sample": "Empty",
  "loading-sample": "Loading"
};

export function DemoApp(): React.JSX.Element {
  const initialSelection = resolveDeepLinkSelection(
    typeof window !== "undefined" ? window.location.search : "",
    DEMO_RUN_ALIASES,
    "local-paired"
  );

  const [selectedAlias, setSelectedAlias] = useState<DemoRunAlias>(initialSelection.runAlias);

  const selectRunAlias = (alias: DemoRunAlias): void => {
    setSelectedAlias(alias);
    if (typeof window !== "undefined") {
      const nextUrl = new URL(window.location.href);
      nextUrl.search = `?run=${alias}`;
      window.history.replaceState(null, "", nextUrl.toString());
    }
  };

  let replayStatus: "empty" | "loading" | "loaded" = "loaded";
  let evidencePayload: unknown = localPairedFixture;
  let fromFixture = true;

  if (selectedAlias === "empty-sample") {
    replayStatus = "empty";
    evidencePayload = null;
  } else if (selectedAlias === "loading-sample") {
    replayStatus = "loading";
    evidencePayload = null;
  } else if (selectedAlias === "invalid-sample") {
    replayStatus = "loaded";
    evidencePayload = INTENTIONALLY_INVALID_SAMPLE;
    fromFixture = false;
  } else if (FIXTURE_REGISTRY.has(selectedAlias)) {
    const map: Record<
      "local-paired" | "awaiting-h200" | "unsupported-backend" | "verifier-failed" | "stale-epoch",
      unknown
    > = {
      "local-paired": localPairedFixture,
      "awaiting-h200": awaitingH200Fixture,
      "unsupported-backend": unsupportedBackendFixture,
      "verifier-failed": verifierFailedFixture,
      "stale-epoch": staleEpochFixture
    };
    evidencePayload = map[selectedAlias];
    fromFixture = true;
  }

  return (
    <div>
      <nav
        aria-label="Frozen fixture alias preview bar"
        style={{
          maxWidth: "1380px",
          margin: "0 auto",
          padding: "12px 24px 0",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "6px",
          fontFamily:
            '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
          fontSize: "12px",
          color: "#9e988c"
        }}
      >
        <span style={{ marginRight: "6px" }}>FIXTURE ALIAS:</span>
        {DEMO_RUN_ALIASES.map((alias) => {
          const active = selectedAlias === alias;
          return (
            <button
              key={alias}
              type="button"
              onClick={() => selectRunAlias(alias)}
              aria-pressed={active}
              data-testid={`fixture-alias-${alias}`}
              style={{
                padding: "4px 9px",
                borderRadius: "3px",
                border: active ? "1px solid #a88eff" : "1px solid #282836",
                backgroundColor: active ? "#221c35" : "#111116",
                color: active ? "#f3efe6" : "#c8c3b8",
                fontFamily: "inherit",
                fontSize: "11.5px",
                cursor: "pointer"
              }}
            >
              {ALIAS_LABELS[alias]}
            </button>
          );
        })}
      </nav>

      {initialSelection.rejectedParams.length > 0 && (
        <div
          role="status"
          data-testid="rejected-deeplink-notice"
          style={{
            maxWidth: "1380px",
            margin: "10px auto 0",
            padding: "8px 24px",
            fontFamily:
              '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
            fontSize: "12px",
            color: "#ebd08b"
          }}
        >
          Ignored non-allowlisted deep-link parameters: {initialSelection.rejectedParams.join(", ")}
        </div>
      )}

      <VervainInferenceReplay
        evidence={evidencePayload}
        status={replayStatus}
        fromFixture={fromFixture}
        initialLane={initialSelection.lane ?? "native_plus_vervain"}
        initialStepIndex={initialSelection.stepIndex ?? undefined}
        defaultReceiptOpen={initialSelection.receiptOpen}
      />
    </div>
  );
}
