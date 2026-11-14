/* Type declarations for the stock Vervain fixtures module (pre-existing; see PROVENANCE.md). */
export interface Observation {
  agent: string;
  at: number;
  kind: string;
  parent?: string;
  path?: string;
  op?: string;
  status?: string;
  client?: string;
  project?: string;
}
export function snapshotAt(
  sc: { observations: Observation[]; t0: number; span: number; title: string },
  T: number,
): { sessions: Array<Record<string, unknown>>; [key: string]: unknown };
