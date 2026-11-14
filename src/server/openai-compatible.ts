/**
 * Responsibility: Minimal OpenAI-compatible chat-completions transport (for example a
 * self-hosted open-weight model behind stock `vllm serve`). It implements the same
 * `GeminiTransport` contract as the official Gemini adapter: it sends the exact envelope the
 * admission gate produced (system instruction, user content, temperature, output budget) and
 * requests the same structured JSON answer shape (`answer`, `sources_used`).
 * Trust boundary: Selected only when PROVIDER=openai_compatible is set explicitly. The
 * admission gate, release gate, and receipts are unchanged and run before and after it.
 * Never logs prompts, chunk text, responses, keys, or raw provider errors.
 */

import type { RuntimeMode } from '../shared/contracts.js';
import type { GeminiOutboundEnvelope } from './envelope.js';
import type { GeminiTransport, TransportRawResult } from './gemini.js';

export const OPENAI_COMPATIBLE_PROVIDER = 'openai_compatible';

const SAFE_MODEL_ID_PATTERN = /^[a-zA-Z0-9._-]{3,80}$/;
const MAX_PROVIDER_BODY_BYTES = 256 * 1024;

/** Same answer schema the Gemini adapter passes as `responseSchema`. */
const ANSWER_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    answer: { type: 'string' },
    sources_used: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'sources_used'],
  additionalProperties: false,
});

export interface OpenAICompatibleSettings {
  /** Base URL that ends at the API root, for example `http://127.0.0.1:18100/v1`. */
  readonly baseUrl: string;
  /** Served model id; must equal the envelope model so receipts name the model that answered. */
  readonly model: string;
  /** Sent as `Authorization: Bearer <key>` when set (OPENAI_COMPAT_API_KEY, for `vllm serve --api-key`). */
  readonly apiKey: string | null;
  /**
   * Sends the system instruction as a prefix of the single user message instead of a `system`
   * message, for chat templates that reject the system role (Gemma). OPENAI_COMPAT_MERGE_SYSTEM
   * is `1` or `0`; when unset it is on for model ids containing "gemma".
   */
  readonly mergeSystemIntoUser: boolean;
}

/** Builds the chat messages for one envelope; the system text is never dropped. */
export function buildChatMessages(
  envelope: Pick<GeminiOutboundEnvelope, 'systemInstruction' | 'userContent'>,
  mergeSystemIntoUser: boolean,
): { role: 'system' | 'user'; content: string }[] {
  if (mergeSystemIntoUser) {
    return [{ role: 'user', content: `${envelope.systemInstruction}\n\n${envelope.userContent}` }];
  }
  return [
    { role: 'system', content: envelope.systemInstruction },
    { role: 'user', content: envelope.userContent },
  ];
}

/**
 * Returns settings only when PROVIDER=openai_compatible is set; returns null otherwise so the
 * default (Gemini or mock) selection is untouched. Throws on an explicit but incomplete setup.
 */
export function loadOpenAICompatibleSettings(
  env: NodeJS.ProcessEnv = process.env,
): OpenAICompatibleSettings | null {
  if ((env.PROVIDER ?? '').trim().toLowerCase() !== OPENAI_COMPATIBLE_PROVIDER) {
    return null;
  }
  const rawBase = (env.OPENAI_COMPAT_BASE_URL ?? '').trim();
  const model = (env.OPENAI_COMPAT_MODEL ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(rawBase);
  } catch {
    throw new Error('PROVIDER=openai_compatible requires a valid OPENAI_COMPAT_BASE_URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OPENAI_COMPAT_BASE_URL must use http or https.');
  }
  if (!SAFE_MODEL_ID_PATTERN.test(model)) {
    throw new Error('PROVIDER=openai_compatible requires OPENAI_COMPAT_MODEL matching [a-zA-Z0-9._-]{3,80}.');
  }
  const apiKey = (env.OPENAI_COMPAT_API_KEY ?? '').trim();
  const rawMerge = (env.OPENAI_COMPAT_MERGE_SYSTEM ?? '').trim();
  const mergeSystemIntoUser =
    rawMerge === '1' ? true : rawMerge === '0' ? false : /gemma/i.test(model);
  return Object.freeze({
    baseUrl: rawBase.replace(/\/+$/, ''),
    model,
    apiKey: apiKey.length > 0 ? apiKey : null,
    mergeSystemIntoUser,
  });
}

/** Content-free record of one model call: no prompt, answer text, or key. */
export interface ModelCallProvenance {
  readonly seq: number;
  readonly method: 'POST';
  readonly path: '/v1/chat/completions';
  readonly endpointHost: string;
  readonly requestedModel: string;
  readonly servedModel: string | null;
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly finishReason: string | null;
  readonly requestId: string | null;
  readonly outcome: string;
  readonly startedAt: string;
}

export class OpenAICompatibleChatTransport implements GeminiTransport {
  public readonly mode: RuntimeMode = 'live';
  private readonly settings: OpenAICompatibleSettings;
  private readonly fetchFn: typeof fetch;
  private readonly observedModels: string[] = [];
  private readonly calls: ModelCallProvenance[] = [];
  private seq = 0;

  constructor(settings: OpenAICompatibleSettings, fetchFn: typeof fetch = fetch) {
    this.settings = settings;
    this.fetchFn = fetchFn;
  }

  public get endpointUrl(): string {
    return `${this.settings.baseUrl}/chat/completions`;
  }

  /** Provenance records with seq greater than `afterSeq` (bounded ring of 64). */
  public getCallsSince(afterSeq: number): readonly ModelCallProvenance[] {
    return this.calls.filter((c) => c.seq > afterSeq);
  }

  public get lastSeq(): number {
    return this.seq;
  }

  private record(p: Omit<ModelCallProvenance, 'seq' | 'method' | 'path' | 'endpointHost' | 'requestedModel'>): void {
    this.seq += 1;
    let host = '';
    try {
      host = new URL(this.settings.baseUrl).host;
    } catch {
      host = '';
    }
    this.calls.push({
      seq: this.seq,
      method: 'POST',
      path: '/v1/chat/completions',
      endpointHost: host,
      requestedModel: this.settings.model,
      ...p,
    });
    if (this.calls.length > 64) this.calls.shift();
  }

  /** Model ids the server reported in its responses, in call order (content-free). */
  public getObservedModelIds(): readonly string[] {
    return [...this.observedModels];
  }

  public async invoke(
    envelope: GeminiOutboundEnvelope,
    options: { timeoutMs: number },
  ): Promise<TransportRawResult> {
    // Receipts record `envelope.model`; refuse to send under a different model id.
    if (envelope.model !== this.settings.model) {
      return { status: 'provider_error', rawText: null };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.settings.apiKey) {
      headers['authorization'] = `Bearer ${this.settings.apiKey}`;
    }

    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    let httpStatus: number | null = null;
    let servedModel: string | null = null;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let finishReason: string | null = null;
    let requestId: string | null = null;
    let outcome = 'provider_error';
    const finish = (status: TransportRawResult['status']): void => {
      outcome = status;
    };
    try {
      const response = await this.fetchFn(this.endpointUrl, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: envelope.model,
          messages: buildChatMessages(envelope, this.settings.mergeSystemIntoUser),
          temperature: envelope.temperature,
          max_tokens: envelope.maxOutputTokens,
          n: 1,
          stream: false,
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'vervain_answer', strict: true, schema: ANSWER_JSON_SCHEMA },
          },
        }),
      });

      httpStatus = response.status;
      const rid = response.headers.get('x-request-id');
      requestId = rid && /^[a-zA-Z0-9._:-]{1,80}$/.test(rid) ? rid : null;
      if (response.status === 429) { finish('http_429'); return { status: 'http_429', rawText: null }; }
      if (response.status === 503) { finish('http_503'); return { status: 'http_503', rawText: null }; }
      if (response.status === 401 || response.status === 403) {
        finish('auth_error');
        return { status: 'auth_error', rawText: null };
      }
      if (!response.ok) return { status: 'provider_error', rawText: null };

      const bodyText = await response.text();
      if (Buffer.byteLength(bodyText, 'utf8') > MAX_PROVIDER_BODY_BYTES) {
        return { status: 'provider_error', rawText: null };
      }
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return { status: 'provider_error', rawText: null };
      }
      const rec = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      if (typeof rec['model'] === 'string') {
        this.observedModels.push(rec['model']);
        servedModel = SAFE_MODEL_ID_PATTERN.test(rec['model']) ? rec['model'] : null;
      }
      if (!requestId && typeof rec['id'] === 'string' && /^[a-zA-Z0-9._:-]{1,80}$/.test(rec['id'])) {
        requestId = rec['id'];
      }
      const usage = (rec['usage'] ?? {}) as Record<string, unknown>;
      promptTokens = typeof usage['prompt_tokens'] === 'number' ? usage['prompt_tokens'] : null;
      completionTokens =
        typeof usage['completion_tokens'] === 'number' ? usage['completion_tokens'] : null;
      const choices = Array.isArray(rec['choices']) ? rec['choices'] : [];
      const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
      finishReason =
        typeof first?.finish_reason === 'string' && first.finish_reason.length <= 32
          ? first.finish_reason
          : null;
      const content = first?.message?.content;
      finish('ok');
      return { status: 'ok', rawText: typeof content === 'string' ? content : null };
    } catch {
      if (controller.signal.aborted) { finish('timeout'); return { status: 'timeout', rawText: null }; }
      finish('provider_unavailable');
      return { status: 'provider_unavailable', rawText: null };
    } finally {
      clearTimeout(timer);
      this.record({
        servedModel,
        httpStatus,
        latencyMs: Date.now() - started,
        promptTokens,
        completionTokens,
        finishReason,
        requestId,
        outcome,
        startedAt,
      });
    }
  }
}
