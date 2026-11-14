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
8. Open-Weight 4-mode KV lifecycle & HMAC `cache_salt` reference workbench (`src/server/open-weight-workbench.ts`)
9. Independent Carbon 3 `inference-proof.v1` JCS SHA-256 & zero-echo verifier seam (`src/server/inference-proof.ts`)

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

---

## Cycle 8: Carbon 3 Proof Sanitizer Nibble-Offset Hex, Non-PASS Manifest Withholding, `-Infinity` Classification, and Query-Order Authority Priority

- **Target surface**: `src/server/inference-proof.ts`, `src/shared/contracts.ts`
- **Adversarial hypothesis**:
  1. Prefixing a mixed-case hex-encoded planted canary (`Beacon_Project_Ember_742`) with a single odd hex nibble (`'f' + hexCanary`) shifts byte alignment by 4 bits and bypasses even-only hex decoding in `containsDecodedPlantedValue`.
  2. Gating `extractRuntimeManifestView` and `extractExclusionsList` on `sanitizerPassed` alone exposes unverified `runtime_manifest` hardware fields (`gpuModel: "NVIDIA H200"`) when an artifact has `verifierVerdict: "FAIL"` (tampered digest / status laundering) or `"NO VERDICT"` (`incomplete` / Python CLI override).
  3. Because `parseStrictInferenceProofJson` checked `if (ch === '-')` before checking `raw.startsWith('-Infinity', idx)`, `-Infinity` returned `FAIL_PARSE_SYNTAX` instead of `FAIL_CANON_NONFINITE_NUMBER`.
  4. `evaluateCoreInvariants` permitted `tp_size <= 0` or fractional `tp_size <= gpu_count` and non-hex64 `receipt_chain` digests when `genesis_sha256` and `head_sha256` matched equal arbitrary strings.
  5. Single-pass query scanning in `detectClientAuthorityOverride` returned `unknown_field` before reaching a trailing authority override parameter (`?foo=bar&tenant_id=beacon`).
- **Root-cause fix**:
  - Updated `containsDecodedPlantedValue` to test both `[0, 1]` hex nibble offsets across `PLANTED_LOWER` and `FIXTURE_TEXT` variants.
  - Gated `runtimeManifest` and `exclusions` exposure strictly on `sanitizerPassed && verifierVerdict === 'PASS'` in both `evaluateInferenceProofArtifactRaw` and the Python CLI merge path of `loadConfiguredInferenceProofStatus`.
  - Checked `NaN` / `Infinity` / `-Infinity` prior to numeric `-` dispatch in `parseStrictInferenceProofJson`, enforced positive integer `1 <= tp_size <= gpu_count` and `/^[0-9a-f]{64}$/` across all `receipt_chain` digests, and split `detectClientAuthorityOverride` query inspection into a two-pass check prioritizing `authority_override_rejected`.
- **Regression tests**: `tests/adversarial/enterprise-and-inference-proof.test.ts` (`18 of 18` suites passing, including Cycle 8 and Cycle 9 regression suites).

---

## Cycle 9: Pure Node 22 Ed25519 `trust-root.v1` Verification, External CLI Anti-Laundering, and Replay Deep-Link Authority Stripping

- **Target surface**: `src/server/inference-proof.ts`, `src/client/components/ScopedAttentionLab.tsx`, `src/client/App.tsx`
- **Adversarial hypothesis**:
  1. In minimal container runtimes without Python installed (`node:22-bookworm-slim` on Cloud Run), `loadConfiguredInferenceProofStatus` previously relied on `pythonVerifierSrc` to verify Ed25519 `trust-root.v1` signatures, returning `NV_TRUST_ROOT_UNPROVIDED` (`NO VERDICT`) even when a valid `trust-root.v1` and Ed25519 signature were supplied.
  2. Conversely, if `pythonVerifierSrc` pointed to a subverted external script returning `{"verdict":"PASS"}`, in-process TypeScript previously allowed `NV_TRUST_ROOT_UNPROVIDED` to clear without verifying the Ed25519 signature bytes against `trustRootPath` directly in Node `node:crypto`.
  3. Navigating to browser deep links containing authority query overrides (`/?run=local-paired&step=7&tenant=beacon&scope=99`) needed deterministic UI stripping and visible override rejection without altering server-owned session authority.
- **Root-cause fix**:
  - Implemented native RFC 8410 Ed25519 SPKI `crypto.verify` and strict `trust-root.v1` parsing (`parseStrictTrustRootJson`, `verifyEmbeddedEd25519Signature`) directly in `src/server/inference-proof.ts`, enforcing `key_id`, `trust_root_id`, `status === 'active'`, `allow_ephemeral_demo`, `not_before <= signed_at <= not_after`, constant-time `signed_digest_sha256` binding, and 64-byte Ed25519 verification in-process before any external CLI merge.
  - Wired Carbon 4 `resolveDeepLinkSelection` in `ScopedAttentionLab.tsx` and `App.tsx` so safe UI parameters (`run`, `step`, `lane`, `receipt`) open the requested fixture state while untrusted authority parameters (`tenant`, `scope`, etc.) are stripped and flagged in `rejected-deeplink-notice`.
- **Regression tests**: `tests/adversarial/enterprise-and-inference-proof.test.ts` (test 18) and `tests/e2e/judge-flow.spec.ts` (passing).
## Imported Daybreak attack-fix evidence before Carbon lead integration

# Daybreak Security Ledger

Append-only attack, fix, and verification log for the hackathon build. This ledger
starts from committed Carbon core `fe545349ab07`. It records local synthetic evidence
only. It does not claim live Gemini, GPU kernel, vLLM, SGLang, or Cloud Run validation.

## 2026-11-14 04:26 PST: model-authored provenance forgery

- Boundary: Gemini response to server release gate.
- Attack: A successful model response named `beacon/strategy-note-v2` in
  `sources_used` while the server-built envelope admitted only
  `alder/renewal-playbook-v3`.
- Failing evidence: `npx vitest run tests/adversarial/model-output-provenance.test.ts`
  released the response instead of withholding it.
- Root cause: The release gate treated model-authored source identifiers as trusted
  display metadata and did not bind them to the outbound envelope.
- Fix: `allowedSourceIds` is now a mandatory release-gate input. Any source claim
  outside that exact set withholds the entire answer with
  `unbound_source_citation`.
- Verification: Direct adversarial test and full HTTP workflow test pass. The HTTP
  test captures an Alder-only envelope, injects a Beacon citation, and observes a
  withheld answer with no released sources.
- Residual boundary: This proves server-side citation binding for this application.
  It does not prove semantic faithfulness of the model's prose to an admitted source.

## 2026-11-14 04:28 PST: malformed Host async rejection

- Boundary: Raw HTTP request to Node process.
- Attack: `Host: [` caused `new URL()` to throw before the router exception boundary.
- Failing evidence: `npx vitest run tests/adversarial/http-ingress-resilience.test.ts`
  observed a rejected promise with `ERR_INVALID_URL` instead of a bounded response.
- Root cause: Request-target parsing occurred outside the router `try` block, and the
  Node HTTP callback returned an uncontained async promise.
- Fix: Invalid request target or Host authority now returns a content-free 400. The
  application server also contains every request promise and emits a bounded 500 or
  closes an already-started response on an unexpected rejection.
- Verification: A raw TCP request receives HTTP 400, followed by a successful 200
  health check against the same server process.
- Residual boundary: Node's own HTTP parser and platform proxy limits remain outside
  this application-level test.

## 2026-11-14 04:29 PST: cross-session eviction at capacity

- Boundary: Unauthenticated session creation to live session storage.
- Attack: Creating a session at the configured cap silently evicted the oldest
  unexpired session, invalidating another user's active cookie.
- Failing evidence: `npx vitest run tests/adversarial/session-isolation.test.ts`
  showed that a third session did not fail at a two-session cap.
- Root cause: Capacity pruning deleted valid records after removing expired records.
- Fix: Capacity cleanup deletes expired sessions only. New unauthenticated creation
  fails closed with HTTP 503 and `session_capacity_reached`; authenticated rotation
  may replace only its own slot.
- Verification: Store-level and HTTP-level tests prove the overflow response is 503,
  the original session remains usable, and legitimate self-rotation still succeeds.
- Residual boundary: This preserves existing sessions but is not a distributed abuse
  prevention system. Deployment-level rate limiting is still recommended.

## 2026-11-14 04:31 PST: ambiguous JSON-prefix media type

- Boundary: Mutation endpoint content-type validation.
- Attack: `Content-Type: application/jsonp` was accepted because validation used a
  string-prefix check.
- Failing evidence: The targeted HTTP test received 200 instead of 415.
- Fix: The parser now extracts the media type before parameters and requires exact
  `application/json`.
- Verification: The adversarial request now receives 415 with
  `invalid_content_type`; ordinary JSON with parameters remains supported by design.

## 2026-11-14 04:32 PST: non-atomic two-level call budget

- Boundary: Per-session and per-instance Gemini call accounting.
- Attack: When the instance window was full, the denied request still consumed the
  session's call allowance. The session remained locked out after the instance window
  cleared even though no provider call occurred.
- Failing evidence: `npx vitest run tests/adversarial/budget-atomicity.test.ts`
  received 429 on the post-window retry instead of 200.
- Root cause: The session reservation mutated state before the instance reservation,
  with no rollback path.
- Fix: Reservation is now a synchronous transaction. An instance-limit failure rolls
  back the just-acquired session allowance.
- Verification: Two independent sessions reproduce the full instance window, the
  second receives the expected 429, time advances beyond the window, and its retry
  succeeds with 200.

## 2026-11-14 04:33 PST: local gate result

- Passed: `npm run typecheck`, `npm run lint`, `npm test` with 25 passed and one
  intentionally skipped live test, `npm run build`, and `npm run proof:paired`.
- Paired proof: Native-only transmitted both synthetic sources and the planted value;
  Native plus Vervain admitted 1 of 2, excluded Beacon and the planted value, released
  the permitted Alder answer, and verified 12 ledger events across two receipts.
- Blocked verifier commands: `npm run verify:bundle` and consequently
  `npm run verify:claims` are declared in committed `package.json`, but their script
  files are absent from committed Carbon core `fe545349ab07`. Carbon has uncommitted
  files at those paths in its owned worktree, so Daybreak did not copy or modify them.

## 2026-11-14 04:34 PST: oversized body reset instead of 413

- Boundary: Bounded HTTP request-body reader.
- Attack: A JSON body larger than 8 KiB caused an immediate socket destroy before the
  application could deliver its declared 413 response.
- Failing evidence: The real HTTP client received `UND_ERR_SOCKET` and zero response
  bytes.
- Fix: The reader stops buffering at the limit and drains ignored remainder bytes while
  the route sends a bounded 413.
- Verification: The client receives 413 with `payload_too_large`, and a subsequent
  health request against the same process returns 200.

## 2026-11-14 04:35 PST: reset-during-generation temporal control

- Boundary: Session reset racing an in-flight provider response.
- Attack: Pause the provider after dispatch, reset the session through the real HTTP
  endpoint, then release the old-generation provider result.
- Result: Existing controls passed. The response was withheld with
  `authority_mismatch`, the answer remained null, and cleared run and receipt state
  were not resurrected.
- Claim limit: This is deterministic application-level temporal consistency evidence,
  not provider-internal KV-cache revocation evidence.

## 2026-11-14 04:36 PST: source-list truncation bypass

- Boundary: Structured model-response parser before release binding.
- Attack: Return eight duplicate allowed citations followed by a forged foreign citation.
  The parser silently truncated the ninth item before the release gate inspected it.
- Failing evidence: Provider outcome was `succeeded` instead of `invalid_response`.
- Fix: Model JSON now uses the strict duplicate-key and prototype-key rejecting parser,
  requires exactly `answer` and `sources_used`, rejects more than eight sources, rejects
  invalid identifiers, and rejects duplicates. No model field is silently dropped.
- Verification: The full HTTP workflow classifies the attack as `invalid_response`,
  does not apply release, and exposes no answer or sources.

## 2026-11-14 04:37 PST: orphan-event verification false positive

- Boundary: Append-only event and receipt-chain verifier.
- Attack: Append a valid event without any covering receipt and ask for chain
  verification.
- Failing evidence: The verifier returned `verified: true` with one event and zero
  receipts.
- Fix: Verification now requires receipt ranges to form a complete, contiguous,
  non-overlapping partition of the event log and validates each declared event count.
- Verification: Orphan events fail with `unreceipted_ledger_events`; existing receipt
  tamper tests and the paired proof remain valid.

## 2026-11-14 04:38 PST: scoped-attention label coercion

- Boundary: Executable CPU scoped-attention reference input validation.
- Attacks: A request tag of `-1` aliased `0xffffffff`; a block tag of `-1` aliased a
  valid request; and a string validity entry was truthy-coerced into an active token.
- Failing evidence: All three cases returned `ok` and exposed the test value vector.
- Fix: Request and block scope tags must be exact uint32 values, scope enforcement must
  be boolean, and every validity slot must be boolean before any attention computation.
- Verification: All attacks now return `failed_closed_invalid_input` with a zero output;
  clean equivalence, foreign mass zero, all-masked, invalid-block, and nonfinite tests pass.
- Claim limit: This hardens only the CPU reference. Production CUDA or Triton evidence
  remains pending the separate inference lane and explicit `GPU GO`.

## 2026-11-14 10:12 PST: response digest omitted source provenance

- Boundary: Released-response evidence recorded in receipts.
- Attack: Release identical answer text twice with different allowed `sources_used`.
- Failing evidence: Both releases produced the same `response_sha256`, so the receipt
  could not distinguish which provenance list the caller saw.
- Fix: Governed and native-control receipts now use a domain-separated SHA-256 over the
  canonical released object containing both `answer` and the ordered `sources_used` list.
  `response_utf8_bytes` measures that same canonical evidence object.
- Verification: The two source variants now produce distinct digests; direct release,
  integration, receipt-chain, type, and lint tests pass.
