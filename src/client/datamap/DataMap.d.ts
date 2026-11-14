/* Type declarations for the stock Vervain DataMap (JavaScript, pre-existing; see PROVENANCE.md). */
import type { ReactElement } from 'react';

export interface DataMapSource {
  label?: string;
  clock: () => number;
  interval?: number;
  poll: (signal?: AbortSignal) => Promise<unknown>;
}

export function DataMap(props: {
  source: DataMapSource;
  onOpen?: (what: string, node: { id: string; kind: string; meta?: Record<string, unknown> }) => boolean | void;
  initialSettings?: Record<string, unknown> | null;
  still?: boolean;
  /** Optional label and tone that replace a card's state line (tone becomes the class is-tag-<tone>). */
  cardTag?: ((node: { id: string; kind: string; meta?: Record<string, unknown> }) => { text: string; tone: string } | null) | null;
  /** When set, the Playback button calls this instead of the stock time-window playback. */
  onPlayback?: (() => void) | null;
  /** Hide the time window, Switches and Audit tools. */
  minimalTools?: boolean;
}): ReactElement;
