import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_TIMELINE_STEPS,
  COPY_CONTRACT,
  createReplayState,
  createSafeFixtureRegistry,
  findBannedClaims,
  generateCausalSummary,
  loadSafeFixture,
  parseEvidenceBundle,
  replayReducer,
  resolveDeepLinkSelection,
  validateEvidenceBundle
} from "../src/core.js";

const fixturesDir = resolve(__dirname, "../../../fixtures/judge-replay");

function loadJsonFixture(filename: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, filename), "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("Evidence Parser & Untrusted Input Hardening", () => {
  it("validates all 5 repository fixtures and confirms NO GPU RUN RECORDED & no live label", () => {
    const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(5);

    for (const file of files) {
      const raw = loadJsonFixture(file);
      const result = loadSafeFixture(raw);
      expect(result.ok, `Fixture ${file} failed loadSafeFixture`).toBe(true);
      if (result.ok) {
        expect(result.value.bundle.gpu_run_recorded).toBe(false);
        expect(result.value.bundle.gpu_status_label).toBe("NO GPU RUN RECORDED");
        expect(result.value.statusBadge).not.toBe("LIVE H200 RUN");
        expect(result.value.statusBadge).not.toBe("RECORDED H200 RUN");
      }
    }
  });

  it("supports recorded and live H200 runtime payloads when valid hardware and sample denominators exist", () => {
    const base = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    base.source_status = "recorded";
    base.gpu_run_recorded = true;
    base.gpu_status_label = "RECORDED H200 SXM ARTIFACT";
    base.hardware = {
      status: "recorded",
      gpu_model: "NVIDIA H200 SXM 141GB",
      gpu_count: 1,
      topology: "1x H200 SXM isolated single-GPU",
      note: "Recorded single-GPU H200 verification run"
    };
    const lanes = base.lanes as Record<string, Record<string, unknown>>;
    for (const laneKey of ["native_only", "native_plus_vervain"]) {
      lanes[laneKey]!.telemetry = {
        ttft_ms: { status: "recorded", p50: 19.2, p95: 23.4, sample_count: 32, unit: "ms", unrecorded_reason: null },
        itl_ms: { status: "recorded", p50: 7.4, p95: 8.9, sample_count: 32, unit: "ms", unrecorded_reason: null },
        throughput_tok_per_s: { status: "recorded", value: 138.5, sample_count: 32, unit: "tok/s", unrecorded_reason: null },
        peak_gpu_memory_gib: { status: "recorded", value: 68.2, sample_count: 32, unit: "GiB", unrecorded_reason: null },
        guard_overhead_us: { status: "recorded", p50: 14.0, p95: 21.0, sample_count: 32, unit: "us", unrecorded_reason: null }
      };
    }

    const recordedRes = parseEvidenceBundle(base);
    expect(recordedRes.ok).toBe(true);
    if (recordedRes.ok) {
      expect(recordedRes.value.statusBadge).toBe("RECORDED H200 RUN");
      expect(recordedRes.value.outcomeClaimEligible).toBe(true);
    }

    const livePayload = clone(base);
    livePayload.source_status = "live";
    const liveDirect = parseEvidenceBundle(livePayload);
    expect(liveDirect.ok).toBe(true);
    if (liveDirect.ok) {
      expect(liveDirect.value.statusBadge).toBe("LIVE H200 RUN");
    }

    // Safe fixture loader MUST reject live status for static fixtures!
    const liveAsFixture = loadSafeFixture(livePayload);
    expect(liveAsFixture.ok).toBe(false);
    if (!liveAsFixture.ok) {
      expect(liveAsFixture.issues[0]?.code).toBe("FIXTURE_LIVE_STATUS_FORBIDDEN");
    }
  });

  it("rejects forbidden protected fields anywhere in the JSON graph without echoing values", () => {
    const forbiddenKeys = [
      "raw_prompt",
      "prompt",
      "planted_value",
      "protected_output",
      "kv_tensor",
      "secret",
      "credential",
      "ip_address",
      "endpoint_url"
    ];

    for (const forbiddenKey of forbiddenKeys) {
      const payload = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
      (payload.policy as Record<string, unknown>)[forbiddenKey] = "SENSITIVE_MARKER_DO_NOT_ECHO";
      const res = parseEvidenceBundle(payload);
      expect(res.ok, `Expected rejection for key ${forbiddenKey}`).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === "FORBIDDEN_PROTECTED_FIELD")).toBe(true);
        const serializedIssues = JSON.stringify(res.issues);
        expect(serializedIssues).not.toContain("SENSITIVE_MARKER_DO_NOT_ECHO");
      }
    }
  });

  it("rejects NaN, Infinity, negative counts, missing denominators, URLs, and text/array cap violations", () => {
    // 1. NaN / Infinity
    const nanPayload = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    (nanPayload.policy as Record<string, unknown>).policy_epoch = Number.NaN;
    const nanRes = parseEvidenceBundle(nanPayload);
    expect(nanRes.ok).toBe(false);
    if (!nanRes.ok) {
      expect(nanRes.issues[0]?.code).toBe("NON_FINITE_OR_IMPOSSIBLE_NUMBER");
    }

    // 2. Metric without denominator
    const noDenom = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    const lanes = noDenom.lanes as Record<string, Record<string, unknown>>;
    (lanes.native_plus_vervain!.correctness as Record<string, Record<string, unknown>>)
      .allowed_requests_completed = {
      status: "recorded",
      numerator: 1,
      denominator: null,
      unit_label: "allowed requests",
      unrecorded_reason: null
    };
    const denomRes = parseEvidenceBundle(noDenom);
    expect(denomRes.ok).toBe(false);
    if (!denomRes.ok) {
      expect(denomRes.issues.some((i) => i.code === "METRIC_MISSING_DENOMINATOR")).toBe(true);
    }

    // 3. Embedded URL in note
    const urlPayload = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    urlPayload.exclusions = ["External trace at https://example.org/trace.json"];
    const urlRes = parseEvidenceBundle(urlPayload);
    expect(urlRes.ok).toBe(false);
    if (!urlRes.ok) {
      expect(urlRes.issues[0]?.code).toBe("UNSAFE_VALUE_PATTERN");
    }

    // 4. Exclusions array cap exceeded
    const capPayload = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    capPayload.exclusions = Array.from({ length: 15 }, (_, idx) => `Exclusion item ${idx}`);
    const capRes = parseEvidenceBundle(capPayload);
    expect(capRes.ok).toBe(false);
    if (!capRes.ok) {
      expect(capRes.issues.some((i) => i.code === "COLLECTION_CAP_EXCEEDED")).toBe(true);
    }

    // 5. Text length cap exceeded
    const longPayload = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    longPayload.exclusions = ["A".repeat(400)];
    const longRes = parseEvidenceBundle(longPayload);
    expect(longRes.ok).toBe(false);
    if (!longRes.ok) {
      expect(longRes.issues.some((i) => i.code === "TEXT_CAP_EXCEEDED")).toBe(true);
    }
  });

  it("emits pairedConfigWarnings and withholds outcome claim when paired lanes diverge on config", () => {
    const mutable = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    const lanes = mutable.lanes as Record<string, Record<string, Record<string, unknown>>>;
    lanes.native_only!.run_config!.seed = 999999;
    lanes.native_only!.run_config!.backend = "XFormers";

    const validated = validateEvidenceBundle(mutable);
    expect(validated.pairedConfigWarnings).toHaveLength(2);
    expect(validated.pairedConfigWarnings.map((w) => w.field)).toEqual(["seed", "backend"]);
    expect(validated.outcomeClaimEligible).toBe(false);
  });

  it("enforces copy contract with zero banned unbounded claims", () => {
    for (const value of Object.values(COPY_CONTRACT)) {
      expect(findBannedClaims(value)).toEqual([]);
      expect(value).not.toContain("\u2014");
    }
  });
});

describe("Replay State Machine & Safe Deep Links", () => {
  it("advances strictly in exact 1..9 causal order during Demo playback and stops at the final recorded step", () => {
    const raw = loadJsonFixture("local-paired-replay.json");
    let state = createReplayState({ status: "loaded", evidence: raw, fromFixture: true });

    // Initial poster state highlights critical boundary step 7
    expect(state.surfaceKind).toBe("ready");
    expect(state.activeStepIndex).toBe(7);
    expect(state.playback).toBe("static");

    // Start Demo resets to step 1 and enters playing
    state = replayReducer(state, { type: "START_DEMO" });
    expect(state.activeStepIndex).toBe(1);
    expect(state.playback).toBe("playing");

    const visited: number[] = [state.activeStepIndex];
    for (let i = 0; i < 12; i += 1) {
      state = replayReducer(state, { type: "TICK" });
      if (visited[visited.length - 1] !== state.activeStepIndex) {
        visited.push(state.activeStepIndex);
      }
    }

    expect(visited).toEqual(CANONICAL_TIMELINE_STEPS.map((s) => s.index));
    // Motion stops when meaning is established at step 9
    expect(state.activeStepIndex).toBe(9);
    expect(state.playback).toBe("static");
  });

  it("never mutates or swaps underlying evidenceRef when switching between Native only and Native plus Vervain", () => {
    const raw = loadJsonFixture("local-paired-replay.json");
    const initial = createReplayState({ status: "loaded", evidence: raw, fromFixture: true });
    const switched = replayReducer(initial, { type: "SET_LANE", lane: "native_only" });
    const switchedBack = replayReducer(switched, { type: "SET_LANE", lane: "native_plus_vervain" });

    expect(switched.activeLane).toBe("native_only");
    expect(switched.evidenceRef).toBe(initial.evidenceRef);
    expect(switchedBack.evidenceRef).toBe(initial.evidenceRef);
  });

  it("routes empty, loading, invalid, verifier_failed, incomplete, unsupported, and stale into first-class states", () => {
    expect(createReplayState({ status: "empty" }).surfaceKind).toBe("empty");
    expect(createReplayState({ status: "loading" }).surfaceKind).toBe("loading");
    expect(createReplayState({ status: "loaded", evidence: { broken: true } }).surfaceKind).toBe(
      "invalid"
    );
    expect(
      createReplayState({
        status: "loaded",
        evidence: loadJsonFixture("verifier-failed-digest.json"),
        fromFixture: true
      }).surfaceKind
    ).toBe("verifier_failed");
    expect(
      createReplayState({
        status: "loaded",
        evidence: loadJsonFixture("awaiting-h200-incomplete.json"),
        fromFixture: true
      }).surfaceKind
    ).toBe("incomplete");
    expect(
      createReplayState({
        status: "loaded",
        evidence: loadJsonFixture("unsupported-backend.json"),
        fromFixture: true
      }).surfaceKind
    ).toBe("unsupported");
    expect(
      createReplayState({
        status: "loaded",
        evidence: loadJsonFixture("stale-policy-epoch.json"),
        fromFixture: true
      }).surfaceKind
    ).toBe("stale");
  });

  it("restricts deep-link query resolution to safe run and timeline aliases and rejects unsafe params", () => {
    const registry = createSafeFixtureRegistry({
      "local-paired": loadJsonFixture("local-paired-replay.json"),
      "awaiting-h200": loadJsonFixture("awaiting-h200-incomplete.json")
    });

    const validLink = resolveDeepLinkSelection(
      "?run=awaiting-h200&step=scope-checked&lane=native&receipt=open",
      registry.aliases,
      "local-paired"
    );
    expect(validLink.runAlias).toBe("awaiting-h200");
    expect(validLink.stepIndex).toBe(6);
    expect(validLink.lane).toBe("native_only");
    expect(validLink.receiptOpen).toBe(true);
    expect(validLink.rejectedParams).toEqual([]);

    const maliciousLink = resolveDeepLinkSelection(
      "?run=https://evil.example/x.json&tenant=alder&fault=override&prompt=hi&step=99",
      registry.aliases,
      "local-paired"
    );
    expect(maliciousLink.runAlias).toBe("local-paired");
    expect(maliciousLink.stepIndex).toBeNull();
    expect(maliciousLink.rejectedParams).toEqual(["tenant", "fault", "prompt", "run", "step"]);
  });

  it("generates HTML-safe causal text summaries with status, denominators, and exclusions", () => {
    const validated = validateEvidenceBundle(loadJsonFixture("local-paired-replay.json"));
    const summary = generateCausalSummary(validated, "native_plus_vervain", 7);
    expect(summary.plainText).toContain("LOCAL TEST");
    expect(summary.plainText).toContain("NO GPU RUN RECORDED");
    expect(summary.plainText).toContain("1 / 1 allowed Birch requests completed");
    expect(summary.plainText).toContain(COPY_CONTRACT.limitLine);
    expect(summary.plainText).toContain(COPY_CONTRACT.outcomeLine);
  });
});
