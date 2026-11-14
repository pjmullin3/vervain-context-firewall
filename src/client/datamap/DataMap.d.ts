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
}): ReactElement;
