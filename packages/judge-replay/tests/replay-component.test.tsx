import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPY_CONTRACT,
  ReceiptDrawer,
  VervainInferenceReplay,
  type ReplayMachineState
} from "../src/index.js";

const fixturesDir = resolve(__dirname, "../../../fixtures/judge-replay");

function loadJsonFixture(filename: string): unknown {
  return JSON.parse(readFileSync(resolve(fixturesDir, filename), "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function summarizeDomStructure(root: HTMLElement) {
  const rootWrapper = root.querySelector("[data-vervain-replay-root]");
  return {
    surfaceKind: rootWrapper?.getAttribute("data-surface-kind") ?? null,
    statusBadge: screen.queryByTestId("source-status-badge")?.textContent ?? null,
    noGpuBadge: screen.queryByTestId("no-gpu-badge")?.textContent ?? null,
    verifierBadge: screen.queryByTestId("verifier-verdict-badge")?.textContent ?? null,
    hasOutcomeClaim: screen.queryByTestId("outcome-claim-line") !== null,
    hasOutcomeWithheld: screen.queryByTestId("outcome-withheld-line") !== null,
    limitLinePresent:
      screen
        .queryByTestId("limit-claim-line")
        ?.textContent?.includes(COPY_CONTRACT.limitLine) ?? false,
    alerts: screen.queryAllByRole("alert").map((el) => el.getAttribute("data-testid") ?? el.tagName),
    headings: screen.queryAllByRole("heading").map((h) => `${h.tagName}:${h.textContent?.trim()}`)
  };
}

describe("VervainInferenceReplay & ReceiptDrawer Component Suite", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("renders the local paired scenario with exact copy contract, NO GPU RUN RECORDED, and critical aperture cut", () => {
    const fixture = loadJsonFixture("local-paired-replay.json");
    render(<VervainInferenceReplay evidence={fixture} fromFixture />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(COPY_CONTRACT.primaryLine);
    expect(screen.getByText(COPY_CONTRACT.technicalLine)).toBeInTheDocument();
    expect(screen.getByTestId("outcome-claim-line")).toHaveTextContent(COPY_CONTRACT.outcomeLine);
    expect(screen.getByTestId("limit-claim-line")).toHaveTextContent(COPY_CONTRACT.limitLine);

    expect(screen.getByTestId("source-status-badge")).toHaveTextContent("LOCAL TEST");
    expect(screen.getByTestId("no-gpu-badge")).toHaveTextContent("NO GPU RUN RECORDED");
    expect(screen.getByTestId("aperture-mismatch-cut")).toBeInTheDocument();
    expect(screen.getByTestId("foreign-path-clipped-segment")).toBeInTheDocument();
  });

  it("switches between Native only and Native plus Vervain without altering underlying evidence", async () => {
    const user = userEvent.setup();
    const fixture = loadJsonFixture("local-paired-replay.json");
    const observedStates: ReplayMachineState[] = [];

    render(
      <VervainInferenceReplay
        evidence={fixture}
        fromFixture
        onStateChange={(st) => observedStates.push(st)}
      />
    );

    const nativeBtn = screen.getByTestId("mode-native-only-btn");
    const vervainBtn = screen.getByTestId("mode-vervain-btn");

    expect(vervainBtn).toHaveAttribute("aria-pressed", "true");
    await user.click(nativeBtn);

    expect(nativeBtn).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("aperture-mismatch-cut")).not.toBeInTheDocument();
    expect(screen.getByTestId("foreign-path-unmediated-segment")).toBeInTheDocument();

    // Underlying evidenceRef stays strictly identical across mode switches
    const firstRef = observedStates[0]?.evidenceRef;
    const latestRef = observedStates[observedStates.length - 1]?.evidenceRef;
    expect(firstRef).not.toBeNull();
    expect(latestRef).toBe(firstRef);
  });

  it("supports keyboard arrow scrubbing (ArrowRight, ArrowLeft, Home, End) and updates causal step readout", () => {
    const fixture = loadJsonFixture("local-paired-replay.json");
    render(<VervainInferenceReplay evidence={fixture} fromFixture initialStepIndex={5} />);

    const step5 = screen.getByTestId("timeline-step-5");
    step5.focus();
    expect(step5).toHaveAttribute("aria-current", "step");

    fireEvent.keyDown(step5, { key: "ArrowRight" });
    const step6 = screen.getByTestId("timeline-step-6");
    expect(step6).toHaveFocus();
    expect(step6).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("active-step-detail")).toHaveTextContent("Step 6 (scope checked)");

    fireEvent.keyDown(step6, { key: "Home" });
    const step1 = screen.getByTestId("timeline-step-1");
    expect(step1).toHaveFocus();
    expect(step1).toHaveAttribute("aria-current", "step");

    fireEvent.keyDown(step1, { key: "End" });
    const step9 = screen.getByTestId("timeline-step-9");
    expect(step9).toHaveFocus();
    expect(step9).toHaveAttribute("aria-current", "step");

    fireEvent.keyDown(step9, { key: "ArrowLeft" });
    const step8 = screen.getByTestId("timeline-step-8");
    expect(step8).toHaveFocus();
    expect(step8).toHaveAttribute("aria-current", "step");
  });

  it("replays Demo deterministically through step 9 and stops automatically; supports Pause, Step, and Restart", () => {
    vi.useFakeTimers();
    const fixture = loadJsonFixture("local-paired-replay.json");
    render(
      <VervainInferenceReplay
        evidence={fixture}
        fromFixture
        demoStepDurationMs={200}
      />
    );

    fireEvent.click(screen.getByTestId("control-demo-btn"));
    expect(screen.getByTestId("timeline-step-1")).toHaveAttribute("aria-current", "step");

    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(screen.getByTestId("timeline-step-3")).toHaveAttribute("aria-current", "step");

    // Pause mid-replay
    fireEvent.click(screen.getByTestId("control-pause-btn"));
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.getByTestId("timeline-step-3")).toHaveAttribute("aria-current", "step");

    // Step forward once
    fireEvent.click(screen.getByTestId("control-step-btn"));
    expect(screen.getByTestId("timeline-step-4")).toHaveAttribute("aria-current", "step");

    // Resume Demo to completion and ensure it halts cleanly at step 9
    fireEvent.click(screen.getByTestId("control-demo-btn"));
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByTestId("timeline-step-9")).toHaveAttribute("aria-current", "step");
    expect(screen.getByTestId("control-demo-btn")).not.toBeDisabled();

    // Restart returns to step 1
    fireEvent.click(screen.getByTestId("control-restart-btn"));
    expect(screen.getByTestId("timeline-step-1")).toHaveAttribute("aria-current", "step");
  });

  it("opens ReceiptDrawer, exposes vLLM SHA, patch digest, denominators, exclusions, and closes on Escape", async () => {
    const user = userEvent.setup();
    const fixture = loadJsonFixture("local-paired-replay.json");
    render(<VervainInferenceReplay evidence={fixture} fromFixture />);

    const openBtn = screen.getByTestId("open-exact-receipt-btn");
    await user.click(openBtn);

    const drawer = screen.getByTestId("receipt-drawer");
    expect(drawer).toBeInTheDocument();
    expect(within(drawer).getByTestId("receipt-vllm-sha")).toHaveTextContent("4d71a92c8b10");
    expect(within(drawer).getByTestId("receipt-gpu-status")).toHaveTextContent(
      "NO GPU RUN RECORDED"
    );
    expect(within(drawer).getByTestId("receipt-exclusions-list")).toHaveTextContent(
      "Other attention backends not selected at runtime are not mediated."
    );

    // Escape closes ReceiptDrawer
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("receipt-drawer")).not.toBeInTheDocument();
  });

  it("honors prefers-reduced-motion media query with discrete non-animated state updates", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false
    });

    try {
      const fixture = loadJsonFixture("local-paired-replay.json");
      const { container } = render(<VervainInferenceReplay evidence={fixture} fromFixture />);
      const root = container.querySelector("[data-vervain-replay-root]");
      expect(root).toHaveAttribute("data-reduced-motion", "true");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("never renders protected fields even when untrusted evidence attempts to inject them", () => {
    const tainted = clone(loadJsonFixture("local-paired-replay.json")) as Record<string, unknown>;
    tainted.raw_prompt = "NEVER_RENDER_RAW_PROMPT_PAYLOAD";
    tainted.planted_value = "NEVER_RENDER_PLANTED_VALUE_PAYLOAD";
    tainted.kv_tensor = "NEVER_RENDER_KV_TENSOR_BYTES";

    const { container } = render(<VervainInferenceReplay evidence={tainted} />);
    expect(screen.getByTestId("state-invalid")).toBeInTheDocument();
    expect(container.textContent).not.toContain("NEVER_RENDER_RAW_PROMPT_PAYLOAD");
    expect(container.textContent).not.toContain("NEVER_RENDER_PLANTED_VALUE_PAYLOAD");
    expect(container.textContent).not.toContain("NEVER_RENDER_KV_TENSOR_BYTES");

    // Standalone ReceiptDrawer also rejects untrusted tainted evidence cleanly
    const drawerRender = render(<ReceiptDrawer open evidence={tainted} mode="inline" />);
    expect(drawerRender.container.textContent).not.toContain("NEVER_RENDER_RAW_PROMPT_PAYLOAD");
  });

  it("renders a prominent configuration mismatch warning when paired lanes diverge", () => {
    const mismatched = clone(loadJsonFixture("local-paired-replay.json")) as Record<
      string,
      Record<string, Record<string, Record<string, unknown>>>
    >;
    mismatched.lanes!.native_only!.run_config!.seed = 777;

    render(<VervainInferenceReplay evidence={mismatched} />);
    expect(screen.getByTestId("paired-config-warning-banner")).toBeInTheDocument();
    expect(screen.queryByTestId("outcome-claim-line")).not.toBeInTheDocument();
    expect(screen.getByTestId("outcome-withheld-line")).toBeInTheDocument();
  });

  it("captures structural snapshots for invalid, incomplete, and verifier-failed states", () => {
    // 1. Invalid
    const invalidRender = render(
      <VervainInferenceReplay evidence={{ schema_version: "bad.v0" }} />
    );
    expect(summarizeDomStructure(invalidRender.container)).toMatchInlineSnapshot(`
      {
        "alerts": [
          "state-invalid",
        ],
        "hasOutcomeClaim": false,
        "hasOutcomeWithheld": true,
        "headings": [
          "H1:IAM ends at access. Vervain keeps identity attached through model memory.",
          "H2:[!] Verification failure: untrusted evidence rejected (18 issues)",
        ],
        "limitLinePresent": true,
        "noGpuBadge": null,
        "statusBadge": "[!]INVALID EVIDENCE",
        "surfaceKind": "invalid",
        "verifierBadge": null,
      }
    `);
    invalidRender.unmount();

    // 2. Incomplete
    const incompleteRender = render(
      <VervainInferenceReplay
        evidence={loadJsonFixture("awaiting-h200-incomplete.json")}
        fromFixture
      />
    );
    expect(summarizeDomStructure(incompleteRender.container)).toMatchInlineSnapshot(`
      {
        "alerts": [],
        "hasOutcomeClaim": false,
        "hasOutcomeWithheld": true,
        "headings": [
          "H1:IAM ends at access. Vervain keeps identity attached through model memory.",
          "H2:Accessible summary of causal replay",
          "H2:△ Incomplete evidence artifact · NO GPU RUN RECORDED",
          "H2:Native plus Vervain: request req_birch_pending_01 (scope:birch)",
          "H2:Causal timeline (3 / 9: context admitted or withheld)",
          "H2:Paired run comparison: Native only vs Native plus Vervain",
        ],
        "limitLinePresent": true,
        "noGpuBadge": "△NO GPU RUN RECORDED",
        "statusBadge": "△INCOMPLETE",
        "surfaceKind": "incomplete",
        "verifierBadge": "△VERIFIER: UNVERIFIED",
      }
    `);
    incompleteRender.unmount();

    // 3. Verifier-Failed
    const failedRender = render(
      <VervainInferenceReplay
        evidence={loadJsonFixture("verifier-failed-digest.json")}
        fromFixture
      />
    );
    expect(summarizeDomStructure(failedRender.container)).toMatchInlineSnapshot(`
      {
        "alerts": [
          "state-verifier-failed",
        ],
        "hasOutcomeClaim": false,
        "hasOutcomeWithheld": true,
        "headings": [
          "H1:IAM ends at access. Vervain keeps identity attached through model memory.",
          "H2:Accessible summary of causal replay",
          "H2:[!] Verification failed: artifact digest or verdict rejected",
          "H2:Native plus Vervain: request req_birch_tamper_01 (scope:birch)",
          "H2:Causal timeline (7 / 9: backend dispatched or stopped)",
          "H2:Paired run comparison: Native only vs Native plus Vervain",
        ],
        "limitLinePresent": true,
        "noGpuBadge": "△NO GPU RUN RECORDED",
        "statusBadge": "◇LOCAL TEST",
        "surfaceKind": "verifier_failed",
        "verifierBadge": "[!]VERIFIER FAILED",
      }
    `);
    failedRender.unmount();
  });
});
