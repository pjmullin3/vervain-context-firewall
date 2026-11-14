/**
 * Responsibility: Official server-side Google GenAI SDK adapter (`@google/genai`),
 * deterministic mock transport, structural envelope-capture spy, bounded retry with jitter,
 * and content-free structured telemetry.
 * Trust boundary: Only server module permitted to communicate with Google Gemini.
 * Never logs prompts, chunk text, responses, keys, or raw provider errors.
 */

import { GoogleGenAI, Type } from '@google/genai';
import { parseStrictJson, type RuntimeMode } from '../shared/contracts.js';
import type { ProviderOutcome } from '../shared/reason-codes.js';
import type { GeminiOutboundEnvelope } from './envelope.js';
import { ALDER_RECORD, BEACON_RECORD, SYNTHETIC_PLANTED_VALUE } from './fixture.js';
import type { SafeStructuredLogger } from './redaction.js';

export interface TransportRawResult {
  readonly status:
    | 'ok'
    | 'http_429'
    | 'http_503'
    | 'timeout'
    | 'auth_error'
    | 'provider_unavailable'
    | 'provider_error';
  readonly rawText: string | null;
}

export interface GeminiTransport {
  readonly mode: RuntimeMode;
  invoke(
    envelope: GeminiOutboundEnvelope,
    options: { timeoutMs: number },
  ): Promise<TransportRawResult>;
}

export interface GeminiExecutionOutcome {
  readonly mode: RuntimeMode;
  readonly model: string;
  readonly callAttempted: boolean;
  readonly outcome: ProviderOutcome;
  readonly latencyMs: number;
  readonly retryCount: number;
  readonly rawText: string | null;
  readonly parsedAnswer: string | null;
  readonly parsedSourcesUsed: readonly string[];
  readonly responseUtf8Bytes: number;
  readonly plantedValueExactMatch: boolean;
}

const MAX_RESPONSE_UTF8_BYTES = 8192;

/**
 * Production Google GenAI transport using the official `@google/genai` SDK.
 * Never falls back to mock output; if `apiKey` is missing or the API fails,
 * returns an explicit failure status.
 */
export class OfficialGoogleGenAITransport implements GeminiTransport {
  public readonly mode: RuntimeMode = 'live';
  private readonly client: GoogleGenAI | null;

  constructor(apiKey: string | null) {
    this.client = apiKey && apiKey.trim().length > 0 ? new GoogleGenAI({ apiKey }) : null;
  }

  public isConfigured(): boolean {
    return this.client !== null;
  }

  public async invoke(
    envelope: GeminiOutboundEnvelope,
    options: { timeoutMs: number },
  ): Promise<TransportRawResult> {
    if (!this.client) {
      return { status: 'provider_unavailable', rawText: null };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await this.client.models.generateContent({
        model: envelope.model,
        contents: envelope.userContent,
        config: {
          systemInstruction: envelope.systemInstruction,
          temperature: envelope.temperature,
          maxOutputTokens: envelope.maxOutputTokens,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              answer: { type: Type.STRING },
              sources_used: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
            },
            required: ['answer', 'sources_used'],
          },
          abortSignal: controller.signal,
        },
      });

      const text = typeof response.text === 'string' ? response.text : null;
      return { status: 'ok', rawText: text };
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return { status: 'timeout', rawText: null };
      }
      const status = extractHttpStatusCode(err);
      if (status === 429) {
        return { status: 'http_429', rawText: null };
      }
      if (status === 503) {
        return { status: 'http_503', rawText: null };
      }
      if (status === 401 || status === 403) {
        return { status: 'auth_error', rawText: null };
      }
      return { status: 'provider_error', rawText: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractHttpStatusCode(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const rec = err as Record<string, unknown>;
  if (typeof rec['status'] === 'number') return rec['status'];
  if (typeof rec['statusCode'] === 'number') return rec['statusCode'];
  if (typeof rec['code'] === 'number') return rec['code'];
  const message = typeof rec['message'] === 'string' ? rec['message'] : '';
  if (/\b429\b/.test(message)) return 429;
  if (/\b503\b/.test(message)) return 503;
  if (/\b(401|403)\b/.test(message)) return 401;
  return null;
}

/**
 * Deterministic mock transport for automated suites and explicit `DEMO_MODE=mock` fallback.
 * Visibly reports `mode: 'mock'` so it can never be mistaken for live Gemini.
 */
export class DeterministicMockGeminiTransport implements GeminiTransport {
  public readonly mode: RuntimeMode = 'mock';
  private readonly customHandler?: (
    envelope: GeminiOutboundEnvelope,
    attempt: number,
  ) => Promise<TransportRawResult> | TransportRawResult;
  private callCounter = 0;

  constructor(
    customHandler?: (
      envelope: GeminiOutboundEnvelope,
      attempt: number,
    ) => Promise<TransportRawResult> | TransportRawResult,
  ) {
    this.customHandler = customHandler;
  }

  public async invoke(envelope: GeminiOutboundEnvelope): Promise<TransportRawResult> {
    this.callCounter += 1;
    if (this.customHandler) {
      return await this.customHandler(envelope, this.callCounter);
    }

    const hasBeacon =
      envelope.userContent.includes(SYNTHETIC_PLANTED_VALUE) ||
      envelope.includedSourceIds.includes(BEACON_RECORD.sourceId);
    const hasAlder = envelope.includedSourceIds.includes(ALDER_RECORD.sourceId);

    if (hasBeacon && hasAlder) {
      return {
        status: 'ok',
        rawText: JSON.stringify({
          answer:
            `Northstar accounts carry a 4 percent standard uplift and allow up to 12 percent renewal discount with director approval on multi-year Net 30 terms. ` +
            `Retrieved context also contained project code ${SYNTHETIC_PLANTED_VALUE}.`,
          sources_used: [ALDER_RECORD.sourceId, BEACON_RECORD.sourceId],
        }),
      };
    }

    if (hasAlder) {
      return {
        status: 'ok',
        rawText: JSON.stringify({
          answer:
            'For Northstar renewals, standard annual uplift is 4 percent, and renewal discounts up to 12 percent may be offered with director approval when multi-year billing is selected on Net 30 terms. No authorized project code was present in the admitted context.',
          sources_used: [ALDER_RECORD.sourceId],
        }),
      };
    }

    return {
      status: 'ok',
      rawText: JSON.stringify({
        answer: 'No authorized commercial renewal guidance was found in the admitted context.',
        sources_used: [],
      }),
    };
  }
}

/**
 * Spy wrapper that captures deep-frozen snapshots of the exact `GeminiOutboundEnvelope`
 * immediately prior to transport invocation, without logging protected content.
 */
export class SpyGeminiTransport implements GeminiTransport {
  private readonly inner: GeminiTransport;
  private readonly captured: GeminiOutboundEnvelope[] = [];

  constructor(inner: GeminiTransport) {
    this.inner = inner;
  }

  public get mode(): RuntimeMode {
    return this.inner.mode;
  }

  public async invoke(
    envelope: GeminiOutboundEnvelope,
    options: { timeoutMs: number },
  ): Promise<TransportRawResult> {
    const snapshot: GeminiOutboundEnvelope = Object.freeze({
      ...envelope,
      includedSourceIds: Object.freeze([...envelope.includedSourceIds]),
    });
    this.captured.push(snapshot);
    return this.inner.invoke(envelope, options);
  }

  public getCapturedEnvelopes(): readonly GeminiOutboundEnvelope[] {
    return [...this.captured];
  }

  public clearCapturedEnvelopes(): void {
    this.captured.length = 0;
  }
}

function parseStructuredModelJson(
  rawText: string,
): { ok: true; answer: string; sourcesUsed: string[] } | { ok: false } {
  const bytes = Buffer.byteLength(rawText, 'utf8');
  if (bytes === 0 || bytes > MAX_RESPONSE_UTF8_BYTES) {
    return { ok: false };
  }

  const parsed = parseStrictJson(rawText);
  if (
    !parsed.ok ||
    parsed.value === null ||
    typeof parsed.value !== 'object' ||
    Array.isArray(parsed.value)
  ) {
    return { ok: false };
  }
  const rec = parsed.value as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== 2 || !keys.includes('answer') || !keys.includes('sources_used')) {
    return { ok: false };
  }
  if (typeof rec['answer'] !== 'string' || rec['answer'].trim().length === 0) {
    return { ok: false };
  }
  const rawSources = rec['sources_used'];
  if (!Array.isArray(rawSources) || rawSources.length > 8) {
    return { ok: false };
  }

  const sourcesUsed: string[] = [];
  const seenSources = new Set<string>();
  for (const rawSource of rawSources) {
    if (typeof rawSource !== 'string') return { ok: false };
    const source = rawSource.trim();
    if (!/^[a-zA-Z0-9/_.-]{1,96}$/.test(source) || seenSources.has(source)) {
      return { ok: false };
    }
    seenSources.add(source);
    sourcesUsed.push(source);
  }

  return {
    ok: true,
    answer: rec['answer'].trim(),
    sourcesUsed,
  };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes an assembled `GeminiOutboundEnvelope` with bounded exponential backoff + jitter
 * strictly for transient `429` and `503` responses, then emits content-free structured telemetry.
 */
export async function executeGeminiEnvelope(params: {
  transport: GeminiTransport;
  envelope: GeminiOutboundEnvelope;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  logger: SafeStructuredLogger;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<GeminiExecutionOutcome> {
  const { transport, envelope, timeoutMs, maxRetries, retryBaseDelayMs, logger } = params;
  const delayFn = params.sleepFn ?? sleepMs;

  const startedMs = Date.now();
  const startedIso = new Date(startedMs).toISOString();
  let retryCount = 0;
  let lastRaw: TransportRawResult = { status: 'provider_error', rawText: null };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      retryCount += 1;
      const exp = retryBaseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.floor(Math.random() * Math.max(10, Math.floor(retryBaseDelayMs * 0.5)));
      await delayFn(exp + jitter);
    }

    lastRaw = await transport.invoke(envelope, { timeoutMs });

    if (lastRaw.status === 'http_429' || lastRaw.status === 'http_503') {
      if (attempt < maxRetries) {
        continue;
      }
    }
    break;
  }

  const completedMs = Date.now();
  const completedIso = new Date(completedMs).toISOString();
  const latencyMs = Math.max(0, completedMs - startedMs);
  const plantedValueExactMatch =
    typeof lastRaw.rawText === 'string' && lastRaw.rawText.includes(SYNTHETIC_PLANTED_VALUE);

  let outcome: ProviderOutcome;
  let parsedAnswer: string | null = null;
  let parsedSourcesUsed: readonly string[] = [];
  let responseUtf8Bytes = 0;

  switch (lastRaw.status) {
    case 'ok': {
      if (lastRaw.rawText === null) {
        outcome = 'invalid_response';
      } else {
        const parsed = parseStructuredModelJson(lastRaw.rawText);
        if (!parsed.ok) {
          outcome = 'invalid_response';
        } else {
          outcome = 'succeeded';
          parsedAnswer = parsed.answer;
          parsedSourcesUsed = Object.freeze(parsed.sourcesUsed);
          responseUtf8Bytes = Buffer.byteLength(parsed.answer, 'utf8');
        }
      }
      break;
    }
    case 'http_429':
      outcome = 'rate_limited';
      break;
    case 'http_503':
    case 'provider_unavailable':
      outcome = 'provider_unavailable';
      break;
    case 'timeout':
      outcome = 'timed_out';
      break;
    case 'auth_error':
      outcome = 'auth_failed';
      break;
    case 'provider_error':
    default:
      outcome = 'provider_error';
      break;
  }

  // Content-free structured provider telemetry (never logs prompt, chunk text, or response text)
  logger.record('gemini_call_completed', {
    request_id: envelope.requestId,
    model: envelope.model,
    mode: transport.mode,
    temperature: envelope.temperature,
    max_output_tokens: envelope.maxOutputTokens,
    admitted_chunk_count: envelope.includedChunkCount,
    prompt_utf8_bytes: envelope.promptUtf8Bytes,
    started_at_iso: startedIso,
    completed_at_iso: completedIso,
    latency_ms: latencyMs,
    retry_count: retryCount,
    response_utf8_bytes: responseUtf8Bytes,
    outcome,
  });

  return Object.freeze({
    mode: transport.mode,
    model: envelope.model,
    callAttempted: true,
    outcome,
    latencyMs,
    retryCount,
    rawText: outcome === 'succeeded' ? lastRaw.rawText : null,
    parsedAnswer,
    parsedSourcesUsed,
    responseUtf8Bytes,
    plantedValueExactMatch,
  });
}
