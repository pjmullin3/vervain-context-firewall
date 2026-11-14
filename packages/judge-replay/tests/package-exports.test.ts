import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as rootPkg from "../src/index.js";
import * as corePkg from "../src/core.js";

describe("Public Package API & Token Exports", () => {
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
});
