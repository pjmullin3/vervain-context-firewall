# 2-Minute Team & Elevator Pitch Video Script

- **Target runtime:** `02:00` (approx. 290 spoken words at ~145 wpm)
- **Format:** Founder on camera (`0:00 - 0:42` and `1:20 - 2:00`) with tight picture-in-picture live product capture (`0:42 - 1:20`)

> **Editorial Note (`OWNER-PROVIDED - VERIFY PUBLIC WORDING`):**
> Confirm the exact official organizer title and ranking for `#1 Open Kernel Challenge finalist` before publishing this video externally. As stated in the script below, founder inference-kernel background explains why this team can execute the future self-hosted engine roadmap; it is **not** cited as evidence for this prototype's boundary enforcement.

---

## 0:00 - 0:20 | Founder Hook: Where Identity Stops

- **Visual:** Founder on camera, clean dark workspace visible on laptop beside speaker.
- **Voiceover / Spoken:**
  "Hi, I'm PJ Mullin, founder of Vervain. Enterprise IAM can tell you that an AI agent belongs to Tenant Alder. What IAM cannot tell you is that one missing filter in your retrieval code just placed Tenant Beacon's confidential strategy note inside Alder's Google Gemini prompt. Once another customer's memory enters model context, system-prompt rules are too late."

---

## 0:20 - 0:45 | Problem Framing: Audit, Alert, Govern After IAM

- **Visual:** Slide or clean diagram overlay showing `IAM Perimeter -> Retrieval / Working Context -> Model Envelope -> Reply`, highlighting `Audit`, `Alert`, `Govern`.
- **Voiceover / Spoken:**
  "As teams ship multi-tenant AI features, identity gets lost across retrieved chunks, session summaries, and KV caches. Teams hit three compounding failures: untraceable context history, cross-tenant contamination, and post-output intervention after inference already ran.
  Vervain is the runtime governance layer after IAM, built around three actions: **Audit** context lineage with hash-chained, payload-free receipts; **Alert** on provenance or policy-epoch mismatches; and **Govern** what enters model context before inference runs and before a reply is released."

---

## 0:45 - 1:18 | Live Paired Gemini Moment & Self-Hosted Reference Math

- **Visual:** Cut to screen capture of `Vervain Context Firewall` (`Google Gemini gemini-2.5-flash LIVE SDK`). Click **`Run paired proof`**, highlight **`Native only`** (`2 of 2 retrieved chunks entered envelope`) vs **`Native + Vervain`** (`1 of 2 retrieved chunks admitted · 1 withheld`, `Released authorized answer`), flash **`Bounded Causal Receipt`**, then open **`Scoped Attention Reference Lab`**.
- **Voiceover / Spoken:**
  "In our live Gemini prototype built on the official Google GenAI SDK, we run the exact same retrieval bug across two lanes. Under `Native only`, Tenant Beacon's restricted note enters the outbound Gemini envelope alongside Alder's commercial playbook. Under `Native + Vervain`, deterministic server-side admission checks provenance before inference, withholds Beacon with `tenant_mismatch`, sends only Alder's playbook to Gemini, rechecks policy epoch 7 at release, and completes Alder's authorized renewal answer with a content-free SHA-256 receipt.
  Below the hosted boundary, our Scoped Attention Reference Lab executes the mathematical roadmap for self-hosted engines: binding that same server-owned scope tag to paged-KV blocks and masking mismatched blocks to zero attention mass before softmax, clearly labeled as reference math rather than production vLLM integration."

---

## 1:18 - 1:42 | Venture-Scale Wedge

- **Visual:** Return to founder on camera (or split view with causal provenance graph).
- **Voiceover / Spoken:**
  "Our wedge into enterprise AI teams is immediate: we start with a cross-tenant contamination assessment that instruments customer retrieval-to-inference paths and surfaces cross-tenant precedent without storing raw customer text. That diagnostic converts directly into Vervain's inline runtime plane across context admission, derived memory, and action release - spanning hosted APIs like Google Gemini today and self-hosted open-weight inference next."

---

## 1:42 - 2:00 | Team Pedigree & Close

- **Visual:** Founder on camera; lower-third text: `PJ Mullin · UC Berkeley Data Science · Ex-Okta ML Products & GTM · Berkeley Haas Research`.
- **Voiceover / Spoken:**
  "I studied Data Science at UC Berkeley, worked on ML products and go-to-market at Okta, ran quantitative research at Berkeley Haas, and was a `#1 Open Kernel Challenge finalist` `[OWNER-PROVIDED - VERIFY PUBLIC WORDING]`. Combining enterprise IAM product DNA with low-level GPU inference background is why we are equipped to take this architecture into production self-hosted serving engines - while today's prototype stands strictly on its own tested boundaries and receipts.
  Identity answers who the agent is. Vervain governs what that identity becomes inside inference."
