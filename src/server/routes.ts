/**
 * Responsibility: Narrow HTTP API router enforcing content-type, payload size, CSRF/Origin
 * same-origin checks, strict duplicate-key-free JSON parsing, authority-override rejection,
 * session ownership, rate limits, and Gemini call budgets.
 * Trust boundary: Untrusted network ingress boundary. Never returns stack traces, raw provider
 * errors, keys, or cross-session receipts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BOUNDARY_LIMIT_NOTE,
  MAX_REQUEST_BODY_BYTES,
  MEDIATED_BOUNDARIES,
} from '../shared/config.js';
import {
  detectClientAuthorityOverride,
  parseStrictJson,
  validateEmptyMutationPayload,
  validatePersonaSessionPayload,
  type DemoStateResponse,
  type EnterpriseArchitectureResponse,
  type RuntimeStatusView,
  type ScopedAttentionProofView,
} from '../shared/contracts.js';
import { API_ERROR_CODES, type ApiErrorCode } from '../shared/reason-codes.js';
import type { ServerConfig } from './config.js';
import { FROZEN_FIXTURE_ID, FROZEN_QUERY_SHA256, FROZEN_QUERY_TEXT } from './fixture.js';
import {
  OfficialGoogleGenAITransport,
  type GeminiTransport,
} from './gemini.js';
import { loadConfiguredInferenceProofStatus } from './inference-proof.js';
import { canonicalJsonString, type AuditLedger } from './ledger.js';
import {
  OPEN_WEIGHT_WORKBENCH_LIMITATION_LABEL,
  buildOpenWeightKvWorkbenchForSession,
  getEnterprisePresets,
  getOpenWeightEngineProfiles,
} from './open-weight-workbench.js';
import type { SafeStructuredLogger } from './redaction.js';
import type { ResponseReleaseGate } from './release.js';
import { buildScopedAttentionProofForSession } from './scoped-attention.js';
import {
  buildSetCookieHeader,
  extractCookieFromHeader,
  SessionCapacityError,
  type ServerAuthoritySnapshot,
  type SessionStore,
} from './session.js';
import {
  type InstanceGeminiBudgetLimiter,
  runCleanRequestWorkflow,
  runPairedProofWorkflow,
  runRevokeDuringGenerationWorkflow,
  type WorkflowDependencies,
} from './workflows.js';

export interface ApiRouterContext {
  readonly config: ServerConfig;
  readonly sessionStore: SessionStore;
  readonly ledger: AuditLedger;
  readonly releaseGate: ResponseReleaseGate;
  readonly transport: GeminiTransport;
  readonly logger: SafeStructuredLogger;
  readonly instanceBudget: InstanceGeminiBudgetLimiter;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
});

export function applySecurityHeaders(res: ServerResponse, isApiRoute: boolean): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(k, v);
  }
  if (isApiRoute) {
    res.setHeader('Cache-Control', 'no-store');
  }
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  applySecurityHeaders(res, true);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, v);
    }
  }
  const serialized = JSON.stringify(body);
  res.statusCode = statusCode;
  res.end(serialized);
}

function sendApiError(
  res: ServerResponse,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
): void {
  sendJson(res, statusCode, {
    error: {
      code,
      message,
    },
  });
}

async function readBoundedRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; raw: string } | { ok: false; code: ApiErrorCode; status: number; message: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (settled) {
        if (totalBytes > maxBytes * 16) {
          req.destroy();
        }
        return;
      }
      if (totalBytes > maxBytes) {
        settled = true;
        resolve({
          ok: false,
          code: API_ERROR_CODES.PAYLOAD_TOO_LARGE,
          status: 413,
          message: `Request body exceeds ${maxBytes} byte limit.`,
        });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, raw: Buffer.concat(chunks).toString('utf8') });
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        code: API_ERROR_CODES.INVALID_REQUEST,
        status: 400,
        message: 'Failed to read request stream.',
      });
    });
  });
}

function verifySameOriginPost(req: IncomingMessage): boolean {
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') {
    const normalizedFetchSite = secFetchSite.trim().toLowerCase();
    if (normalizedFetchSite !== 'same-origin' && normalizedFetchSite !== 'none') {
      return false;
    }
  } else if (Array.isArray(secFetchSite)) {
    return false;
  }

  const origin = req.headers['origin'];
  if (Array.isArray(origin)) {
    return false;
  }
  if (typeof origin === 'string') {
    const trimmedOrigin = origin.trim();
    if (trimmedOrigin === '' || trimmedOrigin.toLowerCase() === 'null') return false;
    const host = req.headers['host'];
    if (typeof host !== 'string' || host.trim().length === 0) return false;
    try {
      const parsedOrigin = new URL(trimmedOrigin);
      if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        return false;
      }
      if (parsedOrigin.username !== '' || parsedOrigin.password !== '') {
        return false;
      }
      if (parsedOrigin.origin.toLowerCase() !== trimmedOrigin.toLowerCase()) {
        return false;
      }
      if (parsedOrigin.host.toLowerCase() !== host.trim().toLowerCase()) {
        return false;
      }
    } catch {
      return false;
    }
  }

  return true;
}

function buildRuntimeStatusView(ctx: ApiRouterContext): RuntimeStatusView {
  const liveConfigured =
    ctx.transport instanceof OfficialGoogleGenAITransport
      ? ctx.transport.isConfigured()
      : ctx.config.geminiApiKey !== null;

  return {
    provider: 'Google Gemini',
    configuredModel: ctx.config.geminiModel,
    mode: ctx.transport.mode,
    liveKeyConfigured: liveConfigured,
    contextMediationState: 'active',
    mediatedBoundariesCount: MEDIATED_BOUNDARIES.length,
    mediatedBoundariesTotal: MEDIATED_BOUNDARIES.length,
    boundaryScopeNote: BOUNDARY_LIMIT_NOTE,
    instanceLifetimeNote:
      'In-memory synthetic session and receipt store; instance restarts clear history.',
  };
}

function requireValidSession(
  req: IncomingMessage,
  ctx: ApiRouterContext,
  res: ServerResponse,
): ServerAuthoritySnapshot | null {
  const cookieToken = extractCookieFromHeader(req.headers.cookie, ctx.config.sessionCookieName);
  const resolved = ctx.sessionStore.resolveCookieToken(cookieToken);
  if (!resolved.ok) {
    sendApiError(
      res,
      401,
      resolved.reason === 'expired'
        ? API_ERROR_CODES.SESSION_EXPIRED
        : API_ERROR_CODES.INVALID_SESSION,
      resolved.reason === 'expired'
        ? 'Synthetic demo session expired. Start a new session.'
        : 'Valid synthetic demo session cookie is required.',
    );
    return null;
  }
  return resolved.snapshot;
}

function mapParseErrorStatus(code: ApiErrorCode): number {
  switch (code) {
    case API_ERROR_CODES.PAYLOAD_TOO_LARGE:
      return 413;
    case API_ERROR_CODES.INVALID_CONTENT_TYPE:
      return 415;
    case API_ERROR_CODES.CSRF_ORIGIN_REJECTED:
      return 403;
    case API_ERROR_CODES.AUTHORITY_OVERRIDE_REJECTED:
    case API_ERROR_CODES.AMBIGUOUS_JSON_PAYLOAD:
    case API_ERROR_CODES.FORBIDDEN_JSON_KEY:
    case API_ERROR_CODES.UNKNOWN_FIELD:
    case API_ERROR_CODES.INVALID_REQUEST:
    default:
      return 400;
  }
}

async function parseAndValidateJsonPost(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (!verifySameOriginPost(req)) {
    sendApiError(
      res,
      403,
      API_ERROR_CODES.CSRF_ORIGIN_REJECTED,
      'Cross-origin mutation request rejected.',
    );
    return { ok: false };
  }

  const contentType = req.headers['content-type'] ?? '';
  const mediaTypeEssence = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaTypeEssence !== 'application/json') {
    sendApiError(
      res,
      415,
      API_ERROR_CODES.INVALID_CONTENT_TYPE,
      'Content-Type must be application/json.',
    );
    return { ok: false };
  }

  const rawBodyResult = await readBoundedRequestBody(req, MAX_REQUEST_BODY_BYTES);
  if (!rawBodyResult.ok) {
    if (rawBodyResult.status === 413) {
      res.setHeader('Connection', 'close');
    }
    sendApiError(res, rawBodyResult.status, rawBodyResult.code, rawBodyResult.message);
    return { ok: false };
  }

  const trimmed = rawBodyResult.raw.trim();
  const jsonToParse = trimmed.length === 0 ? '{}' : rawBodyResult.raw;
  const parsed = parseStrictJson(jsonToParse);
  if (!parsed.ok) {
    sendApiError(res, mapParseErrorStatus(parsed.code), parsed.code, parsed.message);
    return { ok: false };
  }

  const authorityErr = detectClientAuthorityOverride({
    rawHeaders: req.rawHeaders,
    searchParams: url.searchParams,
    bodyValue: parsed.value,
  });
  if (authorityErr) {
    sendApiError(
      res,
      mapParseErrorStatus(authorityErr.code),
      authorityErr.code,
      authorityErr.message,
    );
    return { ok: false };
  }

  return { ok: true, value: parsed.value };
}

/**
 * Handles `/healthz`, `/readyz`, and `/api/*` routes.
 * Returns `true` if handled, or `false` if the caller should pass through to static assets.
 */
export async function handleApiOrProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiRouterContext,
): Promise<boolean> {
  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '/';
  if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    sendApiError(
      res,
      400,
      API_ERROR_CODES.INVALID_REQUEST,
      'Malformed request target.',
    );
    return true;
  }
  const rawHost = req.headers.host ?? 'localhost';
  if (Array.isArray(rawHost) || typeof rawHost !== 'string' || rawHost.trim().length === 0) {
    sendApiError(
      res,
      400,
      API_ERROR_CODES.INVALID_REQUEST,
      'Malformed Host authority header.',
    );
    return true;
  }
  let url: URL;
  try {
    url = new URL(rawUrl, `http://${rawHost}`);
  } catch {
    sendApiError(
      res,
      400,
      API_ERROR_CODES.INVALID_REQUEST,
      'Malformed request target or Host authority.',
    );
    return true;
  }
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    if (method !== 'GET') {
      sendApiError(res, 405, API_ERROR_CODES.METHOD_NOT_ALLOWED, 'GET required.');
      return true;
    }
    sendJson(res, 200, { status: 'alive' });
    return true;
  }

  if (pathname === '/readyz') {
    if (method !== 'GET') {
      sendApiError(res, 405, API_ERROR_CODES.METHOD_NOT_ALLOWED, 'GET required.');
      return true;
    }
    const runtime = buildRuntimeStatusView(ctx);
    const adapterReady =
      runtime.mode === 'mock' || runtime.liveKeyConfigured;
    sendJson(res, adapterReady ? 200 : 503, {
      status: adapterReady ? 'ready' : 'not_ready',
      context_gate: 'ready',
      gemini_adapter_mode: runtime.mode,
      gemini_key_configured: runtime.liveKeyConfigured,
      demo_workflow_ready: adapterReady,
    });
    return true;
  }

  if (!pathname.startsWith('/api/')) {
    return false;
  }

  try {
    // GET routes: enforce zero authority headers/query overrides first
    if (method === 'GET') {
      const headerOrQueryErr = detectClientAuthorityOverride({
        rawHeaders: req.rawHeaders,
        searchParams: url.searchParams,
      });
      if (headerOrQueryErr) {
        sendApiError(
          res,
          mapParseErrorStatus(headerOrQueryErr.code),
          headerOrQueryErr.code,
          headerOrQueryErr.message,
        );
        return true;
      }

      if (pathname === '/api/demo/state') {
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const runs = ctx.sessionStore.getSessionRunsView(authority.sessionId);
        const stateBody: DemoStateResponse = {
          session: ctx.sessionStore.toSafePersonaView(authority),
          runtime: buildRuntimeStatusView(ctx),
          frozenQuery: FROZEN_QUERY_TEXT,
          querySha256: FROZEN_QUERY_SHA256,
          fixtureId: FROZEN_FIXTURE_ID,
          latestPairedRun: runs?.latestPairedRun ?? null,
          latestSingleRun: runs?.latestSingleRun ?? null,
          recentReceiptIds: runs?.recentReceiptIds ?? [],
          ledgerSummary: ctx.ledger.verifyChain(),
        };
        sendJson(res, 200, stateBody);
        return true;
      }

      if (pathname === '/api/demo/scoped-attention') {
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const baseProof = buildScopedAttentionProofForSession(authority);
        const workbench = buildOpenWeightKvWorkbenchForSession(authority);
        const enrichedProof: ScopedAttentionProofView = Object.freeze({
          ...baseProof,
          kvModes: workbench.kvModes,
          onlineTileSteps: workbench.onlineTileSteps,
          engineProfiles: workbench.engineProfiles,
        });
        sendJson(res, 200, enrichedProof);
        return true;
      }

      if (pathname === '/api/inference-proof') {
        if ([...url.searchParams.keys()].length > 0) {
          sendApiError(
            res,
            400,
            API_ERROR_CODES.INVALID_REQUEST,
            'Query parameters are not accepted on /api/inference-proof.',
          );
          return true;
        }
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const proofStatus = loadConfiguredInferenceProofStatus({
          artifactPath: ctx.config.inferenceProofArtifactPath,
          pythonVerifierSrc: ctx.config.evidenceVerifierPythonPath,
          trustRootPath: ctx.config.inferenceProofTrustRootPath,
          requireSignature: ctx.config.inferenceProofRequireSignature,
        });
        sendJson(res, 200, proofStatus);
        return true;
      }

      if (pathname === '/api/demo/enterprise-architecture') {
        if ([...url.searchParams.keys()].length > 0) {
          sendApiError(
            res,
            400,
            API_ERROR_CODES.INVALID_REQUEST,
            'Query parameters are not accepted on /api/demo/enterprise-architecture.',
          );
          return true;
        }
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const inferenceProof = loadConfiguredInferenceProofStatus({
          artifactPath: ctx.config.inferenceProofArtifactPath,
          pythonVerifierSrc: ctx.config.evidenceVerifierPythonPath,
          trustRootPath: ctx.config.inferenceProofTrustRootPath,
          requireSignature: ctx.config.inferenceProofRequireSignature,
        });
        const archBody: EnterpriseArchitectureResponse = Object.freeze({
          limitationNote: OPEN_WEIGHT_WORKBENCH_LIMITATION_LABEL,
          presets: getEnterprisePresets(),
          engineProfiles: getOpenWeightEngineProfiles(),
          inferenceProof,
        });
        sendJson(res, 200, archBody);
        return true;
      }

      if (pathname === '/api/ledger/verify') {
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        sendJson(res, 200, ctx.ledger.verifyChain());
        return true;
      }

      const receiptExportMatch = /^\/api\/receipts\/([a-zA-Z0-9_-]{6,64})\/export$/.exec(pathname);
      if (receiptExportMatch) {
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const receiptId = receiptExportMatch[1]!;
        if (!ctx.sessionStore.ownsReceipt(authority.sessionId, receiptId)) {
          sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Receipt not found in active session.');
          return true;
        }
        const receipt = ctx.ledger.getReceiptById(receiptId);
        if (!receipt) {
          sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Receipt not found.');
          return true;
        }
        applySecurityHeaders(res, true);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="vervain-receipt-${receipt.receipt_id}.json"`,
        );
        res.statusCode = 200;
        res.end(`${canonicalJsonString(receipt)}\n`);
        return true;
      }

      const receiptGetMatch = /^\/api\/receipts\/([a-zA-Z0-9_-]{6,64})$/.exec(pathname);
      if (receiptGetMatch) {
        const authority = requireValidSession(req, ctx, res);
        if (!authority) return true;
        const receiptId = receiptGetMatch[1]!;
        if (!ctx.sessionStore.ownsReceipt(authority.sessionId, receiptId)) {
          sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Receipt not found in active session.');
          return true;
        }
        const receipt = ctx.ledger.getReceiptById(receiptId);
        if (!receipt) {
          sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Receipt not found.');
          return true;
        }
        sendJson(res, 200, { receipt });
        return true;
      }

      if (
        pathname === '/api/demo/session' ||
        pathname === '/api/demo/reset' ||
        pathname === '/api/demo/run-paired' ||
        pathname === '/api/demo/run-clean' ||
        pathname === '/api/demo/revoke-during-generation'
      ) {
        sendApiError(res, 405, API_ERROR_CODES.METHOD_NOT_ALLOWED, 'POST required.');
        return true;
      }

      sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Unknown API endpoint.');
      return true;
    }

    if (method !== 'POST') {
      sendApiError(res, 405, API_ERROR_CODES.METHOD_NOT_ALLOWED, 'Unsupported HTTP method.');
      return true;
    }

    // POST /api/demo/session
    if (pathname === '/api/demo/session') {
      const parsedBody = await parseAndValidateJsonPost(req, url, res);
      if (!parsedBody.ok) return true;
      const validated = validatePersonaSessionPayload(parsedBody.value);
      if (!validated.ok) {
        sendApiError(
          res,
          mapParseErrorStatus(validated.code),
          validated.code,
          validated.message,
        );
        return true;
      }
      const prevCookie = extractCookieFromHeader(
        req.headers.cookie,
        ctx.config.sessionCookieName,
      );
      let created: ReturnType<SessionStore['createOrRotateSession']>;
      try {
        created = ctx.sessionStore.createOrRotateSession(
          validated.value.persona,
          prevCookie,
        );
      } catch (err: unknown) {
        if (err instanceof SessionCapacityError) {
          sendApiError(
            res,
            503,
            API_ERROR_CODES.SESSION_CAPACITY_REACHED,
            'Demo session capacity is temporarily reached. Existing sessions remain active.',
          );
          return true;
        }
        throw err;
      }
      const setCookie = buildSetCookieHeader({
        cookieName: ctx.config.sessionCookieName,
        cookieToken: created.cookieToken,
        maxAgeSeconds: Math.floor(ctx.config.sessionTtlMs / 1000),
        isProduction: ctx.config.nodeEnv === 'production',
      });
      ctx.logger.record('demo_session_rotated', {
        persona: created.snapshot.persona,
        policy_id: created.snapshot.policyId,
        policy_epoch: created.snapshot.policyEpoch,
      });
      sendJson(
        res,
        200,
        {
          session: ctx.sessionStore.toSafePersonaView(created.snapshot),
          runtime: buildRuntimeStatusView(ctx),
        },
        { 'Set-Cookie': setCookie },
      );
      return true;
    }

    const knownPostMutations = new Set([
      '/api/demo/reset',
      '/api/demo/run-paired',
      '/api/demo/run-clean',
      '/api/demo/revoke-during-generation',
    ]);
    if (!knownPostMutations.has(pathname)) {
      if (
        pathname === '/api/demo/state' ||
        pathname === '/api/demo/scoped-attention' ||
        pathname === '/api/demo/enterprise-architecture' ||
        pathname === '/api/inference-proof' ||
        pathname === '/api/ledger/verify' ||
        pathname.startsWith('/api/receipts/')
      ) {
        sendApiError(res, 405, API_ERROR_CODES.METHOD_NOT_ALLOWED, 'GET required.');
        return true;
      }
      sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Unknown API endpoint.');
      return true;
    }

    const parsedMutation = await parseAndValidateJsonPost(req, url, res);
    if (!parsedMutation.ok) return true;
    const emptyCheck = validateEmptyMutationPayload(parsedMutation.value);
    if (!emptyCheck.ok) {
      sendApiError(
        res,
        mapParseErrorStatus(emptyCheck.code),
        emptyCheck.code,
        emptyCheck.message,
      );
      return true;
    }

    const authority = requireValidSession(req, ctx, res);
    if (!authority) return true;

    if (pathname === '/api/demo/reset') {
      if (
        !ctx.sessionStore.checkAndRecordMutationRate(
          authority.sessionId,
          ctx.config.rateLimitMutationsPerMinute,
        )
      ) {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.RATE_LIMIT_EXCEEDED,
          'Rate limit reached for this session. Wait briefly before retrying.',
        );
        return true;
      }
      const updated = ctx.sessionStore.resetSessionState(authority.sessionId);
      if (!updated) {
        sendApiError(res, 401, API_ERROR_CODES.INVALID_SESSION, 'Session no longer active.');
        return true;
      }
      sendJson(res, 200, {
        session: ctx.sessionStore.toSafePersonaView(updated),
        reset: true,
      });
      return true;
    }

    const workflowDeps: WorkflowDependencies = {
      config: ctx.config,
      sessionStore: ctx.sessionStore,
      ledger: ctx.ledger,
      releaseGate: ctx.releaseGate,
      transport: ctx.transport,
      logger: ctx.logger,
      sleepFn: ctx.sleepFn,
    };

    const tryReserveGeminiCallsAtomic = (count: number): boolean => {
      if (
        !ctx.sessionStore.reserveGeminiCalls(
          authority.sessionId,
          count,
          ctx.config.maxGeminiCallsPerSession,
        )
      ) {
        return false;
      }
      if (ctx.instanceBudget.tryReserve(count)) {
        return true;
      }
      ctx.sessionStore.rollbackGeminiCallReservation(authority.sessionId, count);
      return false;
    };

    if (pathname === '/api/demo/run-paired') {
      const result = await ctx.sessionStore.runIdempotentInFlight(
        authority.sessionId,
        'run-paired',
        async () => {
          if (
            !ctx.sessionStore.checkAndRecordMutationRate(
              authority.sessionId,
              ctx.config.rateLimitMutationsPerMinute,
            )
          ) {
            return { kind: 'rate_limit' as const };
          }
          if (!tryReserveGeminiCallsAtomic(2)) {
            return { kind: 'budget' as const };
          }
          const paired = await runPairedProofWorkflow(workflowDeps, authority);
          return { kind: 'ok' as const, paired };
        },
      );

      if (result.kind === 'rate_limit') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.RATE_LIMIT_EXCEEDED,
          'Session request rate limit reached. Wait a moment before running again.',
        );
        return true;
      }
      if (result.kind === 'budget') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.BUDGET_EXCEEDED,
          'Demo Gemini call budget reached for this session. Start a fresh session or wait for the instance window.',
        );
        return true;
      }

      const freshSnap = ctx.sessionStore.getSnapshotBySessionId(authority.sessionId);
      sendJson(res, 200, {
        pairedRun: result.paired,
        session: ctx.sessionStore.toSafePersonaView(
          freshSnap.ok ? freshSnap.snapshot : authority,
        ),
        ledgerSummary: ctx.ledger.verifyChain(),
      });
      return true;
    }

    if (pathname === '/api/demo/run-clean') {
      const result = await ctx.sessionStore.runIdempotentInFlight(
        authority.sessionId,
        'run-clean',
        async () => {
          if (
            !ctx.sessionStore.checkAndRecordMutationRate(
              authority.sessionId,
              ctx.config.rateLimitMutationsPerMinute,
            )
          ) {
            return { kind: 'rate_limit' as const };
          }
          if (!tryReserveGeminiCallsAtomic(1)) {
            return { kind: 'budget' as const };
          }
          const single = await runCleanRequestWorkflow(workflowDeps, authority);
          return { kind: 'ok' as const, single };
        },
      );

      if (result.kind === 'rate_limit') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.RATE_LIMIT_EXCEEDED,
          'Session request rate limit reached. Wait a moment before running again.',
        );
        return true;
      }
      if (result.kind === 'budget') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.BUDGET_EXCEEDED,
          'Demo Gemini call budget reached for this session.',
        );
        return true;
      }

      const freshSnap = ctx.sessionStore.getSnapshotBySessionId(authority.sessionId);
      sendJson(res, 200, {
        run: result.single,
        session: ctx.sessionStore.toSafePersonaView(
          freshSnap.ok ? freshSnap.snapshot : authority,
        ),
        ledgerSummary: ctx.ledger.verifyChain(),
      });
      return true;
    }

    if (pathname === '/api/demo/revoke-during-generation') {
      const result = await ctx.sessionStore.runIdempotentInFlight(
        authority.sessionId,
        'revoke-during-generation',
        async () => {
          if (
            !ctx.sessionStore.checkAndRecordMutationRate(
              authority.sessionId,
              ctx.config.rateLimitMutationsPerMinute,
            )
          ) {
            return { kind: 'rate_limit' as const };
          }
          if (!tryReserveGeminiCallsAtomic(1)) {
            return { kind: 'budget' as const };
          }
          const single = await runRevokeDuringGenerationWorkflow(workflowDeps, authority);
          return { kind: 'ok' as const, single };
        },
      );

      if (result.kind === 'rate_limit') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.RATE_LIMIT_EXCEEDED,
          'Session request rate limit reached. Wait a moment before running again.',
        );
        return true;
      }
      if (result.kind === 'budget') {
        sendApiError(
          res,
          429,
          API_ERROR_CODES.BUDGET_EXCEEDED,
          'Demo Gemini call budget reached for this session.',
        );
        return true;
      }

      const freshSnap = ctx.sessionStore.getSnapshotBySessionId(authority.sessionId);
      sendJson(res, 200, {
        run: result.single,
        session: ctx.sessionStore.toSafePersonaView(
          freshSnap.ok ? freshSnap.snapshot : authority,
        ),
        ledgerSummary: ctx.ledger.verifyChain(),
      });
      return true;
    }

    sendApiError(res, 404, API_ERROR_CODES.NOT_FOUND, 'Unknown API endpoint.');
    return true;
  } catch {
    ctx.logger.record('api_unhandled_exception', {
      path: pathname,
      method,
    });
    if (!res.headersSent) {
      sendApiError(
        res,
        500,
        API_ERROR_CODES.INTERNAL_ERROR,
        'Internal server error; response withheld because mandatory evidence or runtime invariant failed.',
      );
    }
    return true;
  }
}
