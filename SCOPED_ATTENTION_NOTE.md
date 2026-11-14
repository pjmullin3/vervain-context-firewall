# Scoped Attention Mathematical Reference and Kernel Architecture Note

> [!IMPORTANT]
> `Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.`

## 1. Explicit Non-Claims Banner

- **Prototype scope:** `src/server/scoped-attention.ts` and `tests/unit/scoped-attention-exhaustive.test.ts` execute deterministic IEEE-754 double-precision (`float64`) reference calculations in TypeScript on the CPU over small, inspectable paged KV pools.
- **No provider-internal visibility or control:** This reference module does not inspect, mediate, or modify Google Gemini internal weights, KV caches, or provider-side execution state.
- **No GPU or engine backend integration achieved in this repository:** This repository does not execute on a GPU and is not wired into CUDA, Triton, FlashAttention, FlashInfer, or a production vLLM / SGLang runtime backend.
- **No performance or physical-isolation claim:** This prototype makes no latency, throughput, HBM memory-bandwidth, side-channel resistance, or multi-tenant hardware isolation claim.

---

## 2. Exact Reference Equations

### 2.1 Paged KV Pool and Side-Array Representation

Consider a single attention head of dimension $d \in \mathbb{Z}_{>0}$ with scaling factor $\alpha = 1 / \sqrt{d}$ and a physical paged KV pool of $P$ blocks, each holding $B \in \mathbb{Z}_{>0}$ token slots:

- Query vector: $q \in \mathbb{R}^d$
- Physical key pool: $K_{\text{pool}} \in \mathbb{R}^{P \times B \times d}$
- Physical value pool: $V_{\text{pool}} \in \mathbb{R}^{P \times B \times d}$
- Physical block scope-tag side array: $\sigma_{\text{pool}} \in \{0, 1, \dots, 2^{32}-1\}^P$
- Server-derived request scope tag: $\sigma_{\text{req}} \in \{0, 1, \dots, 2^{32}-1\}$
- Sequence logical-to-physical block table of length $M \ge 0$: $\pi = (\pi_0, \dots, \pi_{M-1}) \in \{0, \dots, P-1\}^M$
- Per-logical-block, per-slot ordinary token validity mask (causal / filled-slot mask): $U \in \{0, 1\}^{M \times B}$

### 2.2 Standard Pre-Softmax Scoped Paged Attention

For logical block $b \in \{0, \dots, M-1\}$ and intra-block slot $s \in \{0, \dots, B-1\}$ (flattened position $t = bB + s$):

1. **Scaled dot-product score:**
   $$x_{b,s} = \frac{\langle q,\, K_{\text{pool}}[\pi_b, s] \rangle}{\sqrt{d}}$$
2. **Combined pre-softmax eligibility predicate** (with scope enforcement enabled):
   $$c_{b,s} = U_{b,s} \land \mathbf{1}\!\left[\sigma_{\text{pool}}[\pi_b] = \sigma_{\text{req}}\right]$$
3. **Pre-softmax score masking:**
   $$\tilde{x}_{b,s} = \begin{cases} x_{b,s}, & \text{if } c_{b,s} = 1 \\ -\infty, & \text{if } c_{b,s} = 0 \end{cases}$$
4. **Max-shifted softmax over active positions $\mathcal{A} = \{(b, s) : c_{b,s} = 1\}$:**
   - If $\mathcal{A} = \emptyset$, fail closed with status `refused_all_masked`, weights $w_{b,s} = 0$, and output $O = \mathbf{0} \in \mathbb{R}^d$ (avoiding $0/0 \to \text{NaN}$).
   - Otherwise let $m^\star = \max_{(b,s) \in \mathcal{A}} x_{b,s}$. If $\neg\operatorname{isfinite}(m^\star)$, fail closed with `refused_all_masked` and $O = \mathbf{0}$.
   - Compute stabilized exponentials and partition sum:
     $$e_{b,s} = \begin{cases} \exp(x_{b,s} - m^\star), & (b,s) \in \mathcal{A} \\ 0, & (b,s) \notin \mathcal{A} \end{cases}, \qquad Z = \sum_{(b,s) \in \mathcal{A}} e_{b,s}$$
   - If $\neg\operatorname{isfinite}(Z)$ or $Z \le 0$, fail closed with `refused_all_masked`; else normalize and accumulate:
     $$w_{b,s} = \frac{e_{b,s}}{Z}, \qquad O = \sum_{b=0}^{M-1} \sum_{s=0}^{B-1} w_{b,s}\, V_{\text{pool}}[\pi_b, s]$$

**Why masking must precede max-shift ($m^\star$):** If $m^\star$ were taken over raw unmasked scores before applying $\sigma_{\text{pool}}[\pi_b] = \sigma_{\text{req}}$, a foreign block carrying large positive logits (for example $+10^4$ while authorized logits sit near $0$) would set $m^\star = 10^4$, causing $\exp(x_{\text{own}} - m^\star)$ to underflow IEEE-754 double precision to $0$ and corrupting or refusing the authorized attention row. Applying $c_{b,s}$ prior to $m^\star$ keeps both $m^\star$ and $Z$ invariant to foreign block contents.

### 2.3 Online Block-Tiled `(m, l, O)` Recurrence and Header-Level Block Skipping

Tiled attention kernels evaluate softmax in a single streaming pass over KV blocks using the associative log-sum-exp recurrence without materializing the full $M \cdot B$ score row. Initialize running state prior to $b = 0$:

$$m^{(-1)} = -\infty, \qquad l^{(-1)} = 0, \qquad \tilde{O}^{(-1)} = \mathbf{0} \in \mathbb{R}^d, \qquad \text{mismatchCount} = 0$$

For each logical block $b = 0, \dots, M-1$ with physical index $p = \pi_b$:

1. **Header metadata check (before reading $K_{\text{pool}}[p]$ or $V_{\text{pool}}[p]$):**
   - Let $\text{anyValid}_b = \bigvee_{s=0}^{B-1} U_{b,s}$ and $\text{scopeMatch}_b = (\sigma_{\text{pool}}[p] = \sigma_{\text{req}})$.
   - If $\neg\text{scopeMatch}_b$ (when `enforceScopeMask` is active):
     - If $\text{anyValid}_b$ is true, increment $\text{mismatchCount} \leftarrow \text{mismatchCount} + 1$.
     - **Skip block $b$:** set $(m^{(b)}, l^{(b)}, \tilde{O}^{(b)}) = (m^{(b-1)}, l^{(b-1)}, \tilde{O}^{(b-1)})$ without loading $K_{\text{pool}}[p]$ or $V_{\text{pool}}[p]$.
   - Else if $\neg\text{anyValid}_b$:
     - **Skip block $b$:** set $(m^{(b)}, l^{(b)}, \tilde{O}^{(b)}) = (m^{(b-1)}, l^{(b-1)}, \tilde{O}^{(b-1)})$ without loading $K_{\text{pool}}[p]$ or $V_{\text{pool}}[p]$.
2. **Authorized tile update ($\text{scopeMatch}_b \land \text{anyValid}_b$):**
   - Load tile $K_{\text{block}} = K_{\text{pool}}[p]$ and $V_{\text{block}} = V_{\text{pool}}[p]$.
   - Compute intra-tile valid scores $x_{b,s} = \langle q, K_{\text{block}}[s] \rangle / \sqrt{d}$ for slots with $U_{b,s} = 1$, and tile maximum $m_{\text{tile}} = \max_{s : U_{b,s}=1} x_{b,s}$.
   - Update running maximum and rescaling factor:
     $$m^{(b)} = \max\!\left(m^{(b-1)},\, m_{\text{tile}}\right), \qquad \alpha^{(b)} = \begin{cases} 0, & m^{(b-1)} = -\infty \\ \exp\!\left(m^{(b-1)} - m^{(b)}\right), & m^{(b-1)} > -\infty \end{cases}$$
   - Compute intra-tile exponentials $p_{b,s} = U_{b,s} \cdot \exp(x_{b,s} - m^{(b)})$ and tile denominator $l_{\text{tile}} = \sum_{s=0}^{B-1} p_{b,s}$.
   - Update running denominator and unnormalized output accumulator:
     $$l^{(b)} = \alpha^{(b)}\, l^{(b-1)} + l_{\text{tile}}, \qquad \tilde{O}^{(b)} = \alpha^{(b)}\, \tilde{O}^{(b-1)} + \sum_{s : U_{b,s}=1} p_{b,s}\, V_{\text{block}}[s]$$
     (Equivalently, in per-tile normalized form, $O^{(b)} = \frac{\alpha^{(b)} l^{(b-1)}}{l^{(b)}} O^{(b-1)} + \frac{1}{l^{(b)}} \sum_{s : U_{b,s}=1} p_{b,s}\, V_{\text{block}}[s]$.)
3. **Epilogue after block $M - 1$:**
   - If $l^{(M-1)} \le 0$ or $\neg\operatorname{isfinite}(m^{(M-1)})$ or $\neg\operatorname{isfinite}(l^{(M-1)})$, return `refused_all_masked` and $O = \mathbf{0} \in \mathbb{R}^d$.
   - Otherwise output $O = \tilde{O}^{(M-1)} / l^{(M-1)}$.

**Algebraic equivalence of header-level skipping:** If a mismatched-scope block were loaded into SRAM and masked slot-wise to $\tilde{x}_{b,s} = -\infty$, its tile statistics would be $m_{\text{tile}} = -\infty$, $m^{(b)} = \max(m^{(b-1)}, -\infty) = m^{(b-1)}$, $\alpha^{(b)} = 1$ (or $0$ when $m^{(b-1)} = -\infty$), $p_{b,s} = 0$, $l_{\text{tile}} = 0$, and $\sum_s p_{b,s} V_{\text{block}}[s] = \mathbf{0}$. An all-$-\infty$ tile is the exact identity element of the $(\max, +)$ online softmax state transition. Consequently, a future tiled GPU kernel can branch past HBM loads of $K_{\text{block}}$ and $V_{\text{block}}$ upon observing `block_scope[phys_block] != request_scope` at the side-array header while producing the exact same mathematical output and `refused_all_masked` semantics as slot-wise pre-softmax masking.

---

## 3. Side-Array Metadata Contract and Audit Notes

### 3.1 Metadata and Authority Contract

1. **Per-block `uint32` side array:** Each physical KV block index `physId` in `[0, numPhysical)` carries an unsigned 32-bit scope tag normalized via unsigned shift (`blockScopeTags[physId] >>> 0`), stored separately from key/value vectors.
2. **Server-owned session binding:** In the demo API (`GET /api/demo/scoped-attention` in `src/server/routes.ts`), `requestScopeTag` is read exclusively from the server-side `ServerAuthoritySnapshot` (`0x00a1de07` for Tenant Alder, `0x00beac11` for Tenant Beacon). Client-supplied scope or authority overrides in query parameters (`scope`, `request_scope`, `requestScope`, `scope_id`, `x_request_scope`) or HTTP headers (`X-Request-Scope`, `Request-Scope`, `X-Scope`, `Scope`) are rejected before handler execution with HTTP `400` (`authority_override_rejected`).
3. **Fail-closed statuses:**
   - `failed_closed_invalid_input`: invalid `headDim` / `blockSize`, non-integer scope tags, non-finite `Q` / `K` / `V`, outer `validityMask.length !== blockTable.length`, or pool array length mismatch.
   - `failed_closed_invalid_block_id`: negative, fractional, non-finite, or out-of-bounds (`>= numPhysical`) `blockTable` entries, or inner `validityMask[b].length !== blockSize`.
   - `refused_all_masked`: empty `blockTable`, zero remaining active slots after combining `validityMask` and scope match, or float64 dot-product overflow to `+/-Infinity`, returning all-zero weights and all-zero `output` without `NaN`.

### 3.2 Subtle Implementation Findings in `src/server/scoped-attention.ts`

Inspection and adversarial testing surfaced three subtle behaviors in the current TypeScript reference implementation:

1. **Modulo-$2^{32}$ aliasing on integers outside 32-bit bounds (`scoped-attention.ts:89, 142, 192-193`):** `Number.isInteger(tag)` accepts JavaScript safe integers above `0xffffffff` (for example `0x1_0000_0001 = 4294967297`), which then wrap modulo $2^{32}$ under `>>> 0` to `0x00000001`. High-bit `uint32` tags (`0x80000001` vs `0x00000001` and `0xffffffff` vs `0x7fffffff`) remain distinct without sign-extension error, and signed `Int32` aliases (`0x80000001 | 0`) map consistently, but a production boundary should back the side array with a fixed-width `Uint32Array` / `uint32_t*` and reject out-of-range integers `[0, 0xffffffff]` at ingestion.
2. **Non-integer `pool.headDim` throws `RangeError` in error-return allocation (`scoped-attention.ts:101`):** When `pool.headDim` is non-positive integer (`0` or `-4`), `Math.max(0, d)` evaluates to `0` and returns `status: 'failed_closed_invalid_input'`. When `pool.headDim` is fractional (`1.5`), `NaN`, or `+Infinity`, `new Array<number>(Math.max(0, d))` throws `RangeError: Invalid array length` instead of returning the structured error object. Guarding allocation length with `Number.isInteger(d) && d > 0 ? d : 0` avoids throwing.
3. **Eager referenced-block validation and block-level `maskDisposition` summary (`scoped-attention.ts:156-169, 499-503`):** `runReferencePagedAttention` validates finiteness of `K` and `V` across all slots of every referenced block in `blockTable` (including validity-masked tail slots and foreign-scope blocks), whereas a block-skipping kernel never reads `K`/`V` of skipped foreign blocks. In addition, `buildScopedAttentionProofForSession` labels block #3 (`validFlags = [true, false]`, `scopeMatchesRequest = true`) as `maskDisposition: 'masked_invalid_slot'` because `!validFlags.every(Boolean)`, even though slot 0 is admitted to softmax and carries nonzero post-mask mass (`scopedBlockMass > 0`).

---

## 4. Summary of Executed Numerical and Adversarial Tests

Executed via `npx vitest run tests/unit/scoped-attention-exhaustive.test.ts` (12 test cases, 100% pass, ESLint and TypeScript strict-mode clean):

- **Scaled dot-product and pre-softmax mask invariants:** Verified exact `dot * (1 / Math.sqrt(d))` score identity (`0` error against reference formula, `<= 2 * Number.EPSILON` relative error against `dot / Math.sqrt(d)`), pre-max-shift masking against $+9000$ foreign-key dominance, `|sum(weights) - 1| <= 1e-12`, exact `foreignPostMaskMass === 0`, and `<= 1e-12` $L_\infty$ equivalence to the clean allowed-only twin.
- **Online block-tiled `(m, l, O)` recurrence sweep (80 deterministic seeded configurations, `mulberry32(0x5eedcafe)`):** Swept `d` across `{1, 2, 3, 4, 8, 16, 32, 64, 128}`, `blockSize` across `{1, 2, 3, 4, 8, 16, 32}`, mixed and high-bit `uint32` tags, partial tail masks, all-false empty blocks, repeated physical blocks, non-monotonic / permuted block tables, zero-match `refused_all_masked` tables, and five logit regimes spanning `[-1e4, +1e4]` (including $+10^4$ foreign blocks paired with $-10^4$ authorized blocks). Verified `maxAbsError <= 1e-12` for both unnormalized `tildeO / l` and per-tile normalized `O`, identical `mismatchCount` and `refused_all_masked` status, and **zero** `K_block` / `V_block` reads on foreign-scope blocks via ES `Proxy` read instrumentation.
- **IEEE-754, `uint32`, bounds, and HTTP authority tests:** Verified negative zero (`-0`) handling without `-0` output values, high-bit `uint32` discrimination (`0x80000001` vs `0x00000001`, `0xffffffff` vs `0x7fffffff`), subnormal floats (`Number.MIN_VALUE = 5e-324` through `2.225e-308`), fail-closed handling of `NaN` / `+Infinity` / `-Infinity` in `Q`, `K`, `V`, float64 dot-product overflow (`+/-1e200`), negative/fractional/out-of-bounds `blockTable` IDs, outer and inner `validityMask` dimension mismatches, empty `blockTable`, and live HTTP rejection (`400` / `401` / `405`) of client `scope`, `request_scope`, `requestScope`, `scope_id`, `x_request_scope`, and `X-Request-Scope` overrides on `GET /api/demo/scoped-attention`.

---

## 5. Engineering Gaps Before Production Self-Hosted Deployment

Moving from this CPU mathematical reference to a self-hosted inference engine requires closing ten concrete systems and kernel engineering gates:

1. **Unforgeable scheduler namespace assignment:** The inference gateway and engine scheduler must derive `request_scope` from authenticated server-side workload/tenant credentials and active policy epoch, binding it to internal sequence descriptors while stripping or rejecting any client-supplied header, body, or `cache_salt` override.
2. **Allocator, free, preemption, and eviction tag lifecycle:** The physical KV block allocator must assign `(scope_tag, alloc_generation)` on allocation, monotonically increment `alloc_generation` on reuse, and atomically clear or invalidate `scope_tag` on block free, preemption, swap-out, or remote KV offload so recycled physical block IDs never satisfy stale descriptors.
3. **Atomic block-table-to-tag binding under continuous batching:** Continuous batching mutates block tables across prefill, decode append, copy-on-write forks, and async KV transfers. Scope-tag writes, generation updates, and block-table commits must maintain memory-ordering and stream-synchronization invariants before any attention kernel reads the table.
4. **CUDA graph capture and replay compatibility:** Decoding under captured CUDA graphs reuses fixed device buffer addresses without re-running host Python launch logic. Request scope tags, physical block scope/generation arrays, and fault/mismatch counters must live in pre-allocated device tensors updated prior to graph replay, with in-kernel or pre-replay device checks that cannot be bypassed by graph capture.
5. **FlashInfer, FlashAttention, and Triton backend coverage:** Production engines dispatch across heterogeneous kernels (prefill vs decode, paged GQA/MQA/MLA, chunked prefill, split-KV, FP8/INT8 KV quantization). Every active backend path must enforce identical scope + generation semantics, and the runtime dispatcher must fail closed before launch if an uninstrumented backend or connector is selected.
6. **Prefix-cache hash-key salting:** Automatic prefix caching (radix trees or content-addressed block hashes) must incorporate the server-owned authority scope and policy epoch into every block hash key (including parent-chain hashes) so distinct tenants never collide onto shared physical KV blocks during normal operation, leaving kernel-level scope checks as an independent fault barrier.
7. **Speculative decoding and hybrid Mamba-attention recurrent state:** Draft models, tree/medusa verification buffers, prompt-lookup caches, and hybrid linear-attention / SSM / Mamba recurrent and conv-state slots hold sequence state outside standard paged KV attention tables (often at coarse hybrid block granularities) and require dedicated state-group ownership tracking and clearing.
8. **Side-channel, residency, and tensor-erasure analysis:** Skipping tiles alters per-block execution work and HBM traffic relative to active tiles, creating potential batch-timing or cache-residency side channels across co-scheduled requests. Furthermore, tag clearing prevents logical reuse but does not zeroize residual floating-point values in GPU DRAM without explicit scrubbing on deallocation.
9. **GPU correctness and performance benchmarking:** Production viability requires paired measurements on target accelerators (such as H100/H200) quantifying register pressure, warp divergence, TTFT, TPOT, and HBM bandwidth overhead across batch sizes, context lengths, and tensor-parallel configurations against stock vLLM.
10. **Native runtime receipt binding:** Device-side mismatch counters, allocation-generation verification outcomes, and selected backend identifiers must be read back and bound into tamper-evident, payload-free execution receipts verified by an independent checker.
