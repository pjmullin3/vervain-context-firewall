# Security Ledger - Vervain Context Firewall

## Scope and Posture

This ledger tracks every concrete adversarial campaign, red-team finding, root-cause remediation, and automated regression test executed on the mediated boundaries of `vervain-carbon-demo` (`main`).

Mediated boundaries in this repository:
1. Server-owned synthetic session authority (`src/server/session.ts`)
2. Tenant-scoped retrieval (`src/server/retrieval.ts`)
3. Six-step pre-inference context admission (`src/server/admission.ts`)
4. WeakSet-branded outbound Gemini request envelope (`src/server/envelope.ts`)
5. Nonstreaming response release gate (`src/server/release.ts`)
6. Content-free SHA-256 event and receipt hash chain (`src/server/ledger.ts`, `src/server/receipts.ts`)
7. Reference paged-KV Scoped Attention math (`src/server/scoped-attention.ts`)

Out-of-scope boundaries (explicitly unmediated here):
- Direct database, network, or provider SDK calls bypassing this server
- Closed-weight provider internals after an admitted prompt envelope leaves this server
- Production GPU kernel memory isolation (`src/server/scoped-attention.ts` is a TypeScript reference proof only)
- Full-instance ledger rollback or restart detection without an external checkpoint

---

## Cycle 1: Wire Parser, Authority Smuggling, and Malformed URL Rejection

- **Target surface**: `src/server/routes.ts`, `src/server/app.ts`, `src/shared/contracts.ts`
- **Adversarial hypothesis**: Raw TCP clients can crash or confuse request routing via malformed `req.url` (`//[invalid]`), scheme-relative paths (`//evil.example/api/demo/state`), malformed `Host` headers, duplicate HTTP authority headers (`Sec-Fetch-Site`, `Host`), `application/jsonp` media-type prefix confusion, or `\u0000` JSON escape sequences (`"\\u0000"`).
- **Observed reproduction**:
  1. `new URL(req.url, ...)` threw unhandled `TypeError: Invalid URL` on `//[invalid]` and treated scheme-relative `//evil.example/...` as an external host.
  2. `contentType.startsWith('application/json')` accepted `application/jsonp`.
  3. `parseStrictJson` checked `raw.includes('\u0000')` before JSON escape decoding, allowing `"\\u0000"` into decoded keys and string values.
- **Root-cause fix**:
  - Wrapped URL construction in `routes.ts` and `app.ts` in `try/catch` returning HTTP `400 invalid_request` and explicitly rejected non-slash or `//` scheme-relative paths.
  - Restricted `POST` `Content-Type` media essence (before `;`) to exact `'application/json'`.
  - Added decoded `\u0000` rejection on both keys and string values inside `parseStrictJson` and added `'sec-fetch-site'` and `'host'` to duplicate-header rejection in `detectClientAuthorityOverride`.
- **Regression tests**: `tests/adversarial/races-evidence-and-web.test.ts` and `tests/adversarial/authority-and-sessions.test.ts` (passing).

---

## Cycle 2: Oversized Request Body Socket Drain and CSRF Origin Validation

- **Target surface**: `src/server/routes.ts` (`readBoundedRequestBody`, `verifySameOriginPost`)
- **Adversarial hypothesis**:
  1. Sending a `> 8192`-byte POST body causes premature `req.destroy()` before Node flushes the HTTP `413 payload_too_large` response, resetting the client TCP socket.
  2. Sending `Origin: ftp://127.0.0.1`, `Origin: http://user@host/path`, or `Sec-Fetch-Site: same-site` bypasses strict same-origin mutation checks.
- **Observed reproduction**: Both hypotheses reproduced deterministically in raw socket and fetch tests.
- **Root-cause fix**:
  - Updated `readBoundedRequestBody` to stop buffering above `maxBytes`, drain up to `16 * maxBytes` safely (destroying only runaway multi-megabyte floods), and flush HTTP `413` with `Connection: close`.
  - Hardened `verifySameOriginPost` to require `http:` or `https:` protocol, empty username/password, root empty path/query/hash on `Origin`, exact `parsed.origin === expectedOrigin`, and `Sec-Fetch-Site` restricted to `'same-origin'` or `'none'`.
- **Regression tests**: `tests/adversarial/races-evidence-and-web.test.ts` (passing).

---

## Cycle 3: Unauthenticated Session Table Exhaustion (Active Session Preservation)

- **Target surface**: `src/server/session.ts`, `src/server/routes.ts`
- **Adversarial hypothesis**: Because `POST /api/demo/session` creates synthetic demo sessions without prior credentials, FIFO-evicting the oldest map entry at `maxSessions` lets an unauthenticated flood evict active sessions belonging to other concurrent evaluators.
- **Root-cause fix**:
  - Replaced FIFO active eviction with `pruneExpiredSessions(nowMs)` followed by `SessionCapacityError` when active non-expired sessions reach `maxSessions`, mapped to HTTP `503 session_capacity_reached` in `routes.ts`.
- **Regression tests**: `tests/adversarial/authority-and-sessions.test.ts` (`SessionCapacityError` active-session non-eviction test, passing).

---

## Cycle 4: Response Release Citation Binding and Control-Lane Reason Clarity

- **Target surface**: `src/server/release.ts`, `src/server/workflows.ts`, `src/shared/reason-codes.ts`
- **Adversarial hypothesis**:
  1. A compromised or hallucinating model response could cite a foreign or unadmitted `source_id` in `sources_used` without repeating the exact synthetic planted value string, slipping past `ResponseReleaseGate`.
  2. `executeNativeOnlyControlArm` labeled `ArmExecutionView.releaseReason` as `provider_not_called` even when the synthetic control arm called the provider.
- **Root-cause fix**:
  - Added `allowedSourceIds` enforcement in `ResponseReleaseGate.evaluateRelease`, withholding any candidate whose `parsedSourcesUsed` cites an ID outside `envelope.includedSourceIds` with reason `unbound_source_citation`.
  - Updated `executeNativeOnlyControlArm` to report `releaseReason: 'unmediated_control_release'`.
- **Regression tests**: `tests/adversarial/authority-and-sessions.test.ts` (`unbound_source_citation` test, passing).

---

## Cycle 5: Audit Ledger Payload Immutability and Tenant Label Bounding

- **Target surface**: `src/server/ledger.ts`, `src/server/admission.ts`, `src/shared/config.ts`
- **Adversarial hypothesis**:
  1. Mutating a nested object reference passed into `AuditLedger.appendEvent({ payload })` after append could cause `verifyChain()` to fail later or diverge from canonical hash expectations.
  2. Oversized `tenant_label` strings on untrusted chunks with unrecognized sources were copied unbounded into `ChunkAdmissionDecision.recordTenantLabel`.
- **Root-cause fix**:
  - Added `cloneAndDeepFreezePayload` in `AuditLedger.appendEvent` and `Object.freeze` on shared boundary arrays in `src/shared/config.ts`.
  - Capped `safeLabel` to 64 characters in `src/server/admission.ts`.
- **Regression tests**: `tests/adversarial/races-evidence-and-web.test.ts` and `tests/adversarial/retrieval-admission-envelope.test.ts` (passing).

---

## Cycle 6: Reference Scoped Attention Uint32 Tag Bounds, Safe Dim Guard, and Tail Disposition

- **Target surface**: `src/server/scoped-attention.ts`, `src/shared/contracts.ts`
- **Adversarial hypothesis**:
  1. JavaScript integers above `0xffffffff` (such as `2^32 + 1`) or negative signed integers passed `Number.isInteger` and wrapped modulo `2^32` via `>>> 0`, creating scope-tag aliasing in direct callers.
  2. Non-integer or infinite `pool.headDim` threw `RangeError` at `new Array(...)` instead of returning `'failed_closed_invalid_input'`.
  3. Partially filled authorized tail blocks (`[true, false]`) carried nonzero attention mass while reporting `'masked_invalid_slot'`.
- **Root-cause fix**:
  - Enforced strict unsigned 32-bit bounds (`0 <= tag <= 0xffffffff`) on `requestScopeTag` and every entry of `pool.blockScopeTags`.
  - Guarded `safeDim` (`1 <= d <= 4096`) prior to array allocation and normalized `-0` to `0` across weights and outputs.
  - Added `'admitted_partial_tail'` to `ScopedBlockEvidence['maskDisposition']` for authorized blocks with mixed valid/unused token slots.
- **Regression tests**: `tests/unit/scoped-attention-exhaustive.test.ts` (12 suites including 80-trial seeded online tiled `(m, l, O)` recurrence equivalence and Proxy zero-read verification, passing).

---

## Cycle 7: Atomic Provider Budget Reservation and Strict Model Output Schema

- **Target surface**: `src/server/routes.ts`, `src/server/session.ts`, `src/server/gemini.ts`
- **Adversarial hypothesis**:
  1. When `sessionStore.reserveGeminiCalls` succeeded while `instanceBudget.tryReserve` returned `false`, the session counter stayed incremented without executing a run, prematurely exhausting that session's allowance.
  2. `parseStructuredModelJson` used `JSON.parse` without rejecting duplicate keys, unexpected extra fields, or duplicate/oversized `sources_used` arrays.
- **Root-cause fix**:
  - Added `rollbackGeminiCallReservation` on `SessionStore` and `tryReserveGeminiCallsAtomic` in `routes.ts`.
  - Switched `parseStructuredModelJson` in `src/server/gemini.ts` to `parseStrictJson` (rejecting duplicate keys, prototype keys, and decoded null bytes) while deduplicating and bounding `sources_used` (`<= 8` valid source IDs).
- **Regression tests**: `tests/adversarial/races-evidence-and-web.test.ts` and `tests/adversarial/authority-and-sessions.test.ts` (passing).
