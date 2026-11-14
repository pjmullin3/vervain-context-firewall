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
  readonly apiKey: string | null;
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
  return Object.freeze({
    baseUrl: rawBase.replace(/\/+$/, ''),
    model,
    apiKey: apiKey.length > 0 ? apiKey : null,
  });
}

export class OpenAICompatibleChatTransport implements GeminiTransport {
  public readonly mode: RuntimeMode = 'live';
  private readonly settings: OpenAICompatibleSettings;
  private readonly fetchFn: typeof fetch;
  private readonly observedModels: string[] = [];

  constructor(settings: OpenAICompatibleSettings, fetchFn: typeof fetch = fetch) {
    this.settings = settings;
    this.fetchFn = fetchFn;
  }

  public get endpointUrl(): string {
    return `${this.settings.baseUrl}/chat/completions`;
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

    try {
      const response = await this.fetchFn(this.endpointUrl, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: envelope.model,
          messages: [
            { role: 'system', content: envelope.systemInstruction },
            { role: 'user', content: envelope.userContent },
          ],
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

      if (response.status === 429) return { status: 'http_429', rawText: null };
      if (response.status === 503) return { status: 'http_503', rawText: null };
      if (response.status === 401 || response.status === 403) {
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
      }
      const choices = Array.isArray(rec['choices']) ? rec['choices'] : [];
      const first = choices[0] as { message?: { content?: unknown } } | undefined;
      const content = first?.message?.content;
      return { status: 'ok', rawText: typeof content === 'string' ? content : null };
    } catch {
      if (controller.signal.aborted) return { status: 'timeout', rawText: null };
      return { status: 'provider_unavailable', rawText: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
