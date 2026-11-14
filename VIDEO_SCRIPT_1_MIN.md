# 1-Minute Product Demo Video & Playcast Script

- **Target runtime:** `01:00` exact (`60s`, ~138 spoken words)
- **Viewport:** `1440x900`, dark mode (`#0a0a0b` canvas), clean incognito browser session
- **Runtime posture:** `DEMO_MODE=live` with `GEMINI_API_KEY` configured (`Google Gemini gemini-2.5-flash LIVE SDK` visible in `[data-testid="strip-provider"]`)

---

## Pre-Capture Setup

1. Start production build locally (`npm run build && npm start`) or open the deployed Cloud Run URL.
2. Load `/` in a fresh browser context so `Tenant Alder (alder-operator)` initializes at `alder-context@7` on `[data-testid="empty-proof-stage"]`.
3. Position cursor near `[data-testid="btn-run-paired"]` (`Run paired proof`).

---

## Second-by-Second Action & Voiceover Timeline

| Timestamp | Screen / Playcast Action (Exact Controls & Selectors) | Voiceover (Exact Spoken Lines) |
| --- | --- | --- |
| **00:00 - 00:09** | Hold 2s on top status strip (`[data-testid="status-strip"]`: `Tenant Alder`, `alder-context@7`, `LIVE SDK`, `2/2 in this demo`) and frozen query (`[data-testid="frozen-query-strip"]`). Click **`Run paired proof`** (`[data-testid="btn-run-paired"]`). | "IAM says this session is Tenant Alder at policy epoch 7, yet a missing retriever filter returns Tenant Beacon's restricted note too. Let's click **Run paired proof**." |
| **00:09 - 00:20** | Paired lanes render (`[data-testid="paired-proof-stage"]`). Hover over left card **`Native only`** (`[data-testid="lane-native_only"]`), highlighting badge `Cross-tenant context transmitted` and chip `2 of 2 retrieved chunks entered envelope` (`[data-testid="counts-native_only"]`). | "In **Native only**, both retrieved chunks - including Beacon's foreign strategy note and its override text - enter the outbound Google Gemini envelope." |
| **00:20 - 00:33** | Move cursor to right card **`Native + Vervain`** (`[data-testid="lane-native_plus_vervain"]`), highlighting `Foreign context withheld before Gemini`, `1 of 2 retrieved chunks admitted · 1 withheld`, `epoch 7 -> 7`, and `Released authorized answer` (`[data-testid="reply-box-native_plus_vervain"]`). Briefly sweep across `[data-testid="provenance-graph-panel"]` showing `source_beacon` stopped at `context_gate`. | "In **Native + Vervain**, server-side provenance validation withholds Beacon with `tenant_mismatch` before the Gemini SDK call. Only Alder's commercial playbook reaches Gemini, policy epoch 7 is rechecked at release, and Alder's valid renewal answer completes." |
| **00:33 - 00:46** | Focus lower-right `Bounded Causal Receipt` (`[data-testid="evidence-drawer"]`). Click **`Verify receipt chain`** (`[data-testid="btn-verify-chain"]`) to highlight `verified` in `[data-testid="chain-verification-status"]`, then click **`Export receipt JSON`** (`[data-testid="btn-export-receipt"]`, JSON receipt export) and glance at `[data-testid="coverage-limits"]`. | "We click **Verify receipt chain** and **Export receipt JSON** to inspect the hash-chained receipt: denominators, SHA-256 envelope digests, and explicit exclusions like Gemini's internal KV cache - with zero raw document text in the log." |
| **00:46 - 00:56** | Scroll smoothly to `Self-Hosted Roadmap Layer: Scoped Attention Reference Lab` (`[data-testid="scoped-attention-section"]`) and click **`Open scoped attention proof`** (`[data-testid="btn-open-scoped-attention"]`). Highlight `[data-testid="scoped-limitation-banner"]`, `0x00a1de07`, `1 of 4 blocks masked before softmax`, and `Foreign block post-softmax mass: 0.000000` (`[data-testid="scoped-foreign-mass"]`). | "Opening **Open scoped attention proof** runs our reference math for self-hosted paged-KV engines: binding Alder's server scope tag to mask the foreign block to zero post-softmax mass, clearly labeled as reference math." |
| **00:56 - 01:00** | Hold steady on the full workspace showing the completed Vervain answer, verified receipt chain, and Scoped Attention aperture diagram. | "Vervain governs what identity becomes inside inference." |
