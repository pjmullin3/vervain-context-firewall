/**
 * Locked copy contract and banned unbounded-claim guards for the judge-facing replay.
 */

export const COPY_CONTRACT = Object.freeze({
  productTitle: "Vervain scoped KV firewall",
  creativeThesis:
    "Identity remains attached as data changes form, and the final memory boundary is visible.",
  primaryLine: "IAM ends at access. Vervain keeps identity attached through model memory.",
  technicalLine:
    "A server-owned scope follows each request into vLLM. Before the selected attention backend reads paged KV, Vervain compares the request scope with physical block ownership and allocation generation.",
  outcomeLine: "Foreign block stopped before backend dispatch. Allowed request completed.",
  limitLine:
    "Controlled internal fault injection on the named configuration. Other backends and provider-internal memory are not mediated.",
  noGpuRecordedBanner: "NO GPU RUN RECORDED",
  nativeBaselineNote:
    "Stock vLLM baseline without the added KV scope guard under controlled internal fault injection."
} as const);

export const BANNED_UNBOUNDED_CLAIMS: readonly RegExp[] = Object.freeze([
  /\bproves\b/i,
  /\bguarantees\b/i,
  /\bsecure\b/i,
  /\bcompliant\b/i,
  /\bcertified\b/i,
  /\bproduction[- ]ready\b/i,
  /\bzero[- ]overhead\b/i,
  /\ball engines\b/i
]);

export function findBannedClaims(text: string): string[] {
  const matches: string[] = [];
  for (const pattern of BANNED_UNBOUNDED_CLAIMS) {
    const found = text.match(pattern);
    if (found?.[0]) {
      matches.push(found[0]);
    }
  }
  return matches;
}
