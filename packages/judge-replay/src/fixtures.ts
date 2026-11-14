import { parseEvidenceBundle } from "./parser.js";
import {
  CANONICAL_TIMELINE_STEPS,
  type LaneId,
  type ParseEvidenceResult,
  type TimelineStepId,
  type TimelineStepIndex
} from "./types.js";
import { deepFreeze, escapeHtml } from "./sanitize.js";

const SAFE_ALIAS_REGEX = /^[a-z0-9][a-z0-9_-]{0,47}$/;

const LANE_QUERY_ALIASES: Readonly<Record<string, LaneId>> = {
  vervain: "native_plus_vervain",
  native_plus_vervain: "native_plus_vervain",
  "native-plus-vervain": "native_plus_vervain",
  native: "native_only",
  native_only: "native_only",
  "native-only": "native_only"
};

/**
 * Loads and validates a static fixture object.
 * Enforces that static fixtures can NEVER claim 'live' runtime status.
 */
export function loadSafeFixture(rawFixture: unknown): ParseEvidenceResult {
  const parsed = parseEvidenceBundle(rawFixture);
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.value.bundle.source_status === "live") {
    return {
      ok: false,
      issues: deepFreeze([
        {
          code: "FIXTURE_LIVE_STATUS_FORBIDDEN" as const,
          path: "$.source_status",
          message: "Static fixtures must never claim LIVE H200 RUN status."
        }
      ])
    };
  }
  return parsed;
}

export interface SafeFixtureRegistry<TAlias extends string = string> {
  readonly aliases: readonly TAlias[];
  readonly has: (alias: string) => alias is TAlias;
  readonly getRaw: (alias: string) => unknown;
  readonly load: (alias: string) => ParseEvidenceResult;
}

export function createSafeFixtureRegistry<TAlias extends string>(
  fixturesByAlias: Readonly<Record<TAlias, unknown>>
): SafeFixtureRegistry<TAlias> {
  const entries = new Map<string, unknown>();
  const aliases: TAlias[] = [];

  for (const key of Object.keys(fixturesByAlias) as TAlias[]) {
    if (!SAFE_ALIAS_REGEX.test(key)) {
      throw new Error(`Unsafe fixture alias '${escapeHtml(key)}'; must match ${String(SAFE_ALIAS_REGEX)}.`);
    }
    aliases.push(key);
    entries.set(key, fixturesByAlias[key]);
  }

  return deepFreeze({
    aliases,
    has: (alias: string): alias is TAlias => entries.has(alias),
    getRaw: (alias: string): unknown => {
      if (!SAFE_ALIAS_REGEX.test(alias) || !entries.has(alias)) {
        return undefined;
      }
      return entries.get(alias);
    },
    load: (alias: string): ParseEvidenceResult => {
      if (!SAFE_ALIAS_REGEX.test(alias) || !entries.has(alias)) {
        return {
          ok: false,
          issues: deepFreeze([
            {
              code: "UNSAFE_VALUE_PATTERN" as const,
              path: "$.fixture_alias",
              message: "Requested fixture alias is not in the safe allowlist."
            }
          ])
        };
      }
      return loadSafeFixture(entries.get(alias));
    }
  });
}

export interface SafeDeepLinkSelection<TRunAlias extends string = string> {
  readonly runAlias: TRunAlias;
  readonly stepIndex: TimelineStepIndex | null;
  readonly stepId: TimelineStepId | null;
  readonly lane: LaneId | null;
  readonly receiptOpen: boolean;
  readonly rejectedParams: readonly string[];
}

const DISALLOWED_QUERY_KEYS = new Set([
  "url",
  "endpoint",
  "src",
  "fixture_url",
  "tenant",
  "scope",
  "request_scope",
  "foreign_scope",
  "fault",
  "inject",
  "model",
  "backend",
  "cmd",
  "command",
  "prompt",
  "payload"
]);

/**
 * Resolves URL query strings using strict static allowlists for run alias, step alias, and lane.
 * Rejects arbitrary URLs, scopes, fault parameters, models, prompts, and commands.
 */
export function resolveDeepLinkSelection<TRunAlias extends string>(
  search: string,
  allowedRunAliases: readonly TRunAlias[],
  defaultRunAlias: TRunAlias
): SafeDeepLinkSelection<TRunAlias> {
  const cleanSearch = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(cleanSearch.slice(0, 512));
  const allowedSet = new Set<string>(allowedRunAliases);
  const rejectedParams: string[] = [];

  for (const key of params.keys()) {
    const normalized = key.toLowerCase();
    if (DISALLOWED_QUERY_KEYS.has(normalized)) {
      rejectedParams.push(escapeHtml(key.slice(0, 32)));
    } else if (
      normalized !== "run" &&
      normalized !== "step" &&
      normalized !== "lane" &&
      normalized !== "receipt"
    ) {
      rejectedParams.push(escapeHtml(key.slice(0, 32)));
    }
  }

  let runAlias: TRunAlias = defaultRunAlias;
  const rawRun = params.get("run");
  if (rawRun !== null) {
    if (SAFE_ALIAS_REGEX.test(rawRun) && allowedSet.has(rawRun)) {
      runAlias = rawRun as TRunAlias;
    } else {
      rejectedParams.push("run");
    }
  }

  let stepIndex: TimelineStepIndex | null = null;
  let stepId: TimelineStepId | null = null;
  const rawStep = params.get("step");
  if (rawStep !== null) {
    const byId = CANONICAL_TIMELINE_STEPS.find((s) => s.id === rawStep);
    const numeric = /^[1-9]$/.test(rawStep) ? Number(rawStep) : null;
    const byIndex = numeric !== null ? CANONICAL_TIMELINE_STEPS.find((s) => s.index === numeric) : undefined;
    const matched = byId ?? byIndex;
    if (matched) {
      stepIndex = matched.index;
      stepId = matched.id;
    } else {
      rejectedParams.push("step");
    }
  }

  let lane: LaneId | null = null;
  const rawLane = params.get("lane");
  if (rawLane !== null) {
    const mapped = LANE_QUERY_ALIASES[rawLane];
    if (mapped) {
      lane = mapped;
    } else {
      rejectedParams.push("lane");
    }
  }

  let receiptOpen = false;
  const rawReceipt = params.get("receipt");
  if (rawReceipt !== null) {
    if (rawReceipt === "1" || rawReceipt === "open" || rawReceipt === "true") {
      receiptOpen = true;
    } else if (rawReceipt === "0" || rawReceipt === "closed" || rawReceipt === "false") {
      receiptOpen = false;
    } else {
      rejectedParams.push("receipt");
    }
  }

  return deepFreeze({
    runAlias,
    stepIndex,
    stepId,
    lane,
    receiptOpen,
    rejectedParams
  });
}
