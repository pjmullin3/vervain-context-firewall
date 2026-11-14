/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
// Metadata to shape and physics. One primary size encoding (area), mass derived from the same z so size is never encoded
// twice. Unknown size stays unknown; zero bytes is a different state from unknown.
export const KIND_EXT = Object.freeze({
  code: ['py', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'rs', 'go', 'sh', 'zsh', 'c', 'h', 'cpp', 'java', 'kt', 'swift', 'rb', 'sql', 'css', 'html'],
  prose: ['md', 'txt', 'rst', 'tex', 'adoc', 'pdf', 'doc', 'docx'],
  data: ['json', 'jsonl', 'csv', 'tsv', 'parquet', 'sqlite', 'sqlite3', 'db', 'xml', 'ipynb'],
  media: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'mp4', 'mov', 'mp3', 'wav'],
  config: ['toml', 'yaml', 'yml', 'ini', 'env', 'cfg', 'conf', 'lock', 'plist'],
});
export const KIND_LABEL = Object.freeze({code: 'Code', prose: 'Prose', data: 'Structured data', media: 'Media', config: 'Configuration', unknown: 'Unknown type'});
export function fileKind(path) {
  const name = String(path || '').split('/').pop() || '', ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (name.startsWith('.env') || /^(Makefile|Dockerfile|LICENSE)$/.test(name)) return 'config';
  for (const [kind, list] of Object.entries(KIND_EXT)) if (list.includes(ext)) return kind;
  return 'unknown';
}
/** z = clamp(log(1 + bytes/b0) / log(1 + B/b0), 0, 1); null when bytes is unknown. */
export function sizeZ(bytes, b0 = 2048, B = 4 * 1024 * 1024) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes))) return null;
  return Math.max(0, Math.min(1, Math.log(1 + Math.max(0, Number(bytes)) / b0) / Math.log(1 + B / b0)));
}
const AREA = {min: 216 * 64, max: 216 * 104}, MASS = {min: 1, max: 2.6};
/** Card geometry and mass from a projected node. Linear dimensions come from sqrt(area) so area is the one size channel. */
export function bodyFor(node) {
  const kind = node.kind;
  if (kind === 'box') return {w: 196, h: 176, r: 120, m: 1e9, fixed: true, silhouette: 'box', z: null};
  if (kind === 'agent') return {w: 232, h: 92, r: 124, m: 1.8, silhouette: node.spawned ? 'task' : 'agent', z: null};
  if (kind === 'request') return {w: 232, h: 92, r: 124, m: 1.8, silhouette: 'request', z: null};
  if (kind === 'agent_group') return {w: 250, h: 106, r: 135, m: 2.2, silhouette: 'agent-group', z: null};
  if (kind === 'destination') return {w: 212, h: 72, r: 112, m: 1.6, silhouette: 'cloud', z: null};
  if (kind === 'folder') { const z = sizeZ(node.meta?.bytes ?? null); return {w: 220, h: 74, r: 116, m: 1.6, silhouette: node.expanded ? 'folder-open' : 'folder', z}; }
  const z = sizeZ(node.meta?.bytes ?? node.meta?.sent_bytes ?? null);
  const area = z === null ? AREA.min : AREA.min + (AREA.max - AREA.min) * z, scale = Math.sqrt(area / AREA.min);
  return {w: Math.round(216 * scale), h: Math.round(64 * scale), r: Math.round(112 * scale), m: z === null ? MASS.min : MASS.min + (MASS.max - MASS.min) * z, silhouette: `file-${fileKind(node.meta?.path)}`, z, sizeState: z === null ? 'unknown' : Number(node.meta?.bytes ?? node.meta?.sent_bytes) === 0 ? 'empty' : 'known'};
}
/** Folder aggregate over observed files only, de-duplicated by digest when present, otherwise by path. */
export function folderAggregate(files) {
  const seen = new Set(); let bytes = 0, known = 0, unknown = 0;
  for (const f of files) { const k = f.digest || f.path; if (seen.has(k)) continue; seen.add(k); if (Number.isFinite(Number(f.bytes))) { bytes += Number(f.bytes); known++; } else unknown++; }
  return {bytes: known ? bytes : null, known, unknown, label: `${known} observed ${known === 1 ? 'file' : 'files'}${unknown ? `, ${unknown} without size` : ''}`, partial: unknown > 0};
}
