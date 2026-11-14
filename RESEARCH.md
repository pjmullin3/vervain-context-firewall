# Focused Technical Research Notes (`RESEARCH.md`)

Concise implementation facts verified prior to building **Vervain Context Firewall**.

## 1. Official Google GenAI TypeScript SDK (`@google/genai`)

- **Package**: `@google/genai` (`^3.3.0`), official unified Google GenAI SDK for Node.js (`>=22.0.0`).
- **Initialization**: `new GoogleGenAI({ apiKey })` on the server process only. Never bundle `@google/genai` or `GEMINI_API_KEY` into Vite client assets.
- **Generation call**: `ai.models.generateContent({ model, contents, config })` where `config` supports `systemInstruction`, `temperature`, `maxOutputTokens`, `responseMimeType: 'application/json'`, `responseSchema`, and `abortSignal` for bounded request timeouts.
- **Retry posture**: Transient provider HTTP status codes `429` (rate limit) and `503` (service unavailable) warrant bounded exponential backoff with random jitter (`maxRetries = 2`). Status codes `400`, `401`, `403`, and `404` indicate deterministic configuration or credential errors and must fail immediately without retry.

## 2. JSON Parser Ambiguity and Prototype Pollution in Node.js

- V8 `JSON.parse` silently resolves duplicate object keys (`{"persona":"alder","persona":"beacon"}`) to the last key, which can create parser differentials if upstream proxies or downstream validators inspect raw JSON differently.
- V8 `JSON.parse` also materializes `"__proto__"` as an own property when parsed directly, which can pollute targets during naive object merges.
- **Mitigation implemented**: `parseStrictJson` in `src/shared/contracts.ts` runs a deterministic RFC 8259 lexical key-uniqueness and forbidden-key (`__proto__`, `constructor`, `prototype`) pass over the exact UTF-8 string before returning frozen plain data structures.

## 3. Cloud Run Single-Service Deployment Contract

- Cloud Run injects `PORT` (default `8080`) and terminates TLS at the Google Front End (`X-Forwarded-Proto: https`).
- Serving both the built Vite static bundle (`dist/client`) and `/api/*` + `/healthz` + `/readyz` from one Node.js HTTP process eliminates cross-origin CORS complexity, enables `SameSite=Lax` (or `Strict`) `HttpOnly` session cookies on the exact origin, and enforces uniform `Origin` / `Sec-Fetch-Site` checks on `POST` routes.

## 4. Numerically Stable Masked Softmax for Scoped Attention Reference

- Standard attention over paged blocks computes $S_{i} = \frac{q \cdot k_i}{\sqrt{d_k}}$ for token positions mapped via `block_table`.
- Combining ordinary token-validity masking ($M^{\text{valid}}_i \in \{0,1\}$) with scope-tag equality ($M^{\text{scope}}_i = \mathbb{I}[\text{tag}(\text{block}(i)) = \text{scope}_{\text{req}}]$) BEFORE softmax sets $S'_i = -\infty$ wherever $M^{\text{valid}}_i \land M^{\text{scope}}_i = 0$.
- If all positions in a row are masked ($\max_i S'_i = -\infty$), naive `exp(-Infinity - (-Infinity))` produces `NaN`. Fail-closed handling explicitly checks `activeCount === 0` before exponentiation and returns zero weights, zero output vector, and `status: 'refused_all_masked'` with zero `NaN`/`Infinity` values.
