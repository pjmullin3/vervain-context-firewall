import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as rootPkg from "../src/index.js";
import * as corePkg from "../src/core.js";

const repoRoot = resolve(__dirname, "../../..");

describe("Public Package API, Token Exports & Handoff Manifest Parity", () => {
  it("exports all required functions, components, constants, and CSS custom property tokens", () => {
    expect(typeof rootPkg.parseEvidenceBundle).toBe("function");
    expect(typeof rootPkg.validateEvidenceBundle).toBe("function");
    expect(typeof rootPkg.createReplayState).toBe("function");
    expect(typeof rootPkg.replayReducer).toBe("function");
    expect(typeof rootPkg.VervainInferenceReplay).toBe("function");
    expect(typeof rootPkg.ReceiptDrawer).toBe("function");
    expect(typeof rootPkg.generateCausalSummary).toBe("function");
    expect(typeof rootPkg.loadSafeFixture).toBe("function");
    expect(typeof rootPkg.createSafeFixtureRegistry).toBe("function");
    expect(typeof rootPkg.resolveDeepLinkSelection).toBe("function");

    expect(rootPkg.EVIDENCE_SCHEMA_VERSION).toBe("vervain.judge_replay.v1");
    expect(rootPkg.CANONICAL_TIMELINE_STEPS).toHaveLength(9);
    expect(rootPkg.VERVAIN_REPLAY_TOKENS["--vr-bg-canvas"]).toBe("#0b0b0e");
    expect(rootPkg.VERVAIN_REPLAY_TOKENS["--vr-text-primary"]).toBe("#f3efe6");
    expect(rootPkg.VERVAIN_REPLAY_TOKENS["--vr-accent-purple"]).toBe("#a88eff");
    expect(rootPkg.VERVAIN_REPLAY_TOKENS_CSS).toContain("--vr-bg-canvas: #0b0b0e;");

    // Framework-neutral core barrel excludes React requirement while exposing core helpers
    expect(typeof corePkg.parseEvidenceBundle).toBe("function");
    expect(typeof corePkg.createReplayState).toBe("function");
    expect(typeof corePkg.generateCausalSummary).toBe("function");
    expect(typeof corePkg.loadSafeFixture).toBe("function");
  });

  it("ships tokens.css and replay.css with matching CSS custom property definitions", () => {
    const tokensCssPath = resolve(__dirname, "../src/styles/tokens.css");
    const replayCssPath = resolve(__dirname, "../src/styles/replay.css");
    expect(existsSync(tokensCssPath)).toBe(true);
    expect(existsSync(replayCssPath)).toBe(true);

    const tokensCss = readFileSync(tokensCssPath, "utf8");
    for (const tokenName of Object.keys(rootPkg.VERVAIN_REPLAY_TOKENS)) {
      expect(tokensCss).toContain(tokenName);
    }
  });

  it("executes the exact lead-app handoff integration contract end-to-end", () => {
    const localPaired = JSON.parse(
      readFileSync(resolve(repoRoot, "fixtures/judge-replay/local-paired-replay.json"), "utf8")
    ) as unknown;
    const awaitingH200 = JSON.parse(
      readFileSync(resolve(repoRoot, "fixtures/judge-replay/awaiting-h200-incomplete.json"), "utf8")
    ) as unknown;

    const registry = rootPkg.createSafeFixtureRegistry({
      "local-paired": localPaired,
      "awaiting-h200": awaitingH200
    });

    const deepLink = rootPkg.resolveDeepLinkSelection(
      "?run=local-paired&step=7&lane=vervain&receipt=open&tenant=blocked",
      registry.aliases,
      "local-paired"
    );

    const activePayload = registry.getRaw(deepLink.runAlias);
    expect(activePayload).toBeDefined();

    render(
      React.createElement(rootPkg.VervainInferenceReplay, {
        evidence: activePayload,
        fromFixture: true,
        initialLane: deepLink.lane,
        initialStepIndex: deepLink.stepIndex,
        initialReceiptOpen: deepLink.receiptOpen,
        rejectedDeepLinkParams: deepLink.rejectedParams
      })
    );

    expect(screen.getByTestId("receipt-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("rejected-deeplink-notice")).toHaveTextContent("tenant");
  });

  it("verifies HANDOFF.json exports list and file inventory match runtime exports and disk files", () => {
    const handoffPath = resolve(repoRoot, "HANDOFF.json");
    expect(existsSync(handoffPath)).toBe(true);
    const handoff = JSON.parse(readFileSync(handoffPath, "utf8")) as {
      package: { exports: string[] };
      files: string[];
    };

    const runtimeRecord = rootPkg as Record<string, unknown>;
    for (const exportName of handoff.package.exports) {
      expect(
        runtimeRecord[exportName],
        `HANDOFF.json listed export '${exportName}' that is missing from @vervain/judge-replay`
      ).toBeDefined();
    }

    for (const relFile of handoff.files) {
      expect(
        existsSync(resolve(repoRoot, relFile)),
        `HANDOFF.json listed file '${relFile}' that does not exist`
      ).toBe(true);
    }
  });
});
