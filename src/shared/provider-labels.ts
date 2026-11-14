/**
 * Responsibility: The words the demo screen uses for the model, derived from the provider the
 * server actually selected, so a self-hosted run is never labelled Gemini (and the reverse).
 * Trust boundary: Pure display helpers shared by the browser bundle and tests; no secrets.
 */

import type { RuntimeMode, RuntimeStatusView } from './contracts.js';

/** The Gemini path keeps its existing product name on screen. */
export const GEMINI_DISPLAY_NAME = 'Gemini 4 Carbon';

export type ProviderLabelInput = Pick<
  RuntimeStatusView,
  'providerKind' | 'providerHostLabel' | 'configuredModel'
>;

export interface ModelLabels {
  /** Header chip, for example "gemma-3-27b-it · our H200 · LIVE" or "Gemini 4 Carbon · LIVE". */
  readonly chip: string;
  /** The model's actor name on the map. */
  readonly node: string;
  /** Short name for sentences ("Asking ...", "LEAKED into ..."). */
  readonly short: string;
}

function modeWord(mode: RuntimeMode | null): string {
  return mode === null ? '...' : mode === 'live' ? 'LIVE' : 'MOCK';
}

/**
 * Labels for the active provider. `runtime` is null until /api/demo/state answers; the Gemini
 * wording is the fallback only then. `model` is the model id a run reported, when there is one.
 */
export function modelLabels(
  runtime: ProviderLabelInput | null,
  mode: RuntimeMode | null,
  model?: string | null,
): ModelLabels {
  if (runtime?.providerKind === 'openai_compatible') {
    const name = model || runtime.configuredModel;
    const host = runtime.providerHostLabel ?? 'our H200';
    return {
      chip: `${name} · ${host} · ${modeWord(mode)}`,
      node: `${name} (open model on ${host})`,
      short: name,
    };
  }
  return {
    chip: `${GEMINI_DISPLAY_NAME} · ${modeWord(mode)}`,
    node: `${GEMINI_DISPLAY_NAME} (model)`,
    short: 'Gemini',
  };
}
