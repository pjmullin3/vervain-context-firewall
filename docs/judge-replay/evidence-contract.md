# Evidence Contract (`vervain.judge_replay.v1`)

All visual states in `@vervain/judge-replay` derive strictly from validated `vervain.judge_replay.v1` inputs. Status is never inferred or upgraded.

## Source Status Mapping

| `source_status` | Rendered status pill | Requirements |
| --- | --- | --- |
| `"live"` | `LIVE H200 RUN` | Allowed only via runtime `parseEvidenceBundle` (rejected by `loadSafeFixture`); requires `gpu_run_recorded: true`, non-null `hardware.gpu_model`, recorded sample denominators, and all 9 steps recorded. |
| `"recorded"` | `RECORDED H200 RUN` | Requires `gpu_run_recorded: true`, non-null `hardware.gpu_model`, recorded sample denominators, and all 9 steps recorded. |
| `"local_only"` | `LOCAL TEST` | Pre-GPU deterministic contract harness; when `gpu_run_recorded: false`, must set `gpu_status_label: "NO GPU RUN RECORDED"` and keep all GPU telemetry `not_recorded`. |
| `"incomplete"` | `INCOMPLETE` | Contiguous prefix of recorded steps (`1..k`); remaining steps marked `recorded: false` (`disposition: "unrecorded"`). Outcome claim is withheld. |
| `"unsupported"` | `UNSUPPORTED` | Requires non-empty `unsupported_reason`; missing mediation is never rendered as a favorable outcome. Outcome claim is withheld. |

## Untrusted Input Hardening Rules

`parseEvidenceBundle` treats every input as untrusted:

1. **Strict allowlisted keys**: Any unknown property at any object level is rejected (`UNKNOWN_FIELD`).
2. **Forbidden protected keys**: Recursive graph scan immediately rejects keys matching prompts (`prompt`, `raw_prompt`, `system_prompt`), planted values (`planted_value`, `canary`), raw outputs (`protected_output`, `raw_output`, `completion_text`), tensors (`kv_tensor`, `tensor_bytes`, `tensor_data`), credentials (`secret`, `api_key`, `private_key`, `credential`, `password`, `authorization`, `cookie`, `access_token`), or network addresses (`address`, `ip_address`, `endpoint_url`, `email`, `dsn`). Rejected values are never echoed into error messages or the DOM.
3. **Disallowed string patterns**: Strings containing URL schemes (`https://`, `ws://`, `tcp://`, `ssh://`), IPv4 addresses, email addresses, PEM blocks, API token prefixes, JWT tokens, ASCII control characters, or Unicode bidirectional overrides are rejected (`UNSAFE_VALUE_PATTERN`).
4. **Numeric bounds & denominators**: `NaN`, `Infinity`, negative counts, and impossible latency/memory numbers are rejected. Every recorded correctness or telemetry metric must carry a positive integer `denominator` or `sample_count` (`METRIC_MISSING_DENOMINATOR`).
5. **Collection & text caps**: Identifiers max 64-96 chars; short labels max 120 chars; notes/exclusions max 260 chars; `exclusions` max 12 items; `blocks` max 8 per lane; `lineage` max 8 items; `steps` exact 9 canonical causal steps in order.
6. **Verification failure over best-effort success**: If `verifier.verdict === "failed"` or `verifier.canonical_sha256 !== verifier.computed_sha256`, the component enters `verifier_failed` mode, displays an explicit verification alert, and withholds the outcome line.

## Plugging in a Post-Hold H200 Artifact

Once PJ issues `GPU GO` after 10:00 AM PT on November 14, 2026 and the engine lane seals a verified H200 receipt:

1. Set `source_status` to `"recorded"` (or `"live"` for a live stream snapshot passed directly via `evidence` prop).
2. Set `gpu_run_recorded: true` and `gpu_status_label: "RECORDED H200 SXM ARTIFACT"`.
3. Populate `hardware`:
   ```json
   {
     "status": "recorded",
     "gpu_model": "NVIDIA H200 SXM 141GB",
     "gpu_count": 1,
     "topology": "1x H200 SXM isolated single-GPU",
     "note": "Recorded paired H200 verification run"
   }
   ```
4. Populate `telemetry` on both lanes with `status: "recorded"` and integer `sample_count >= 1` for `ttft_ms`, `itl_ms`, `throughput_tok_per_s`, `peak_gpu_memory_gib`, and `guard_overhead_us`.
5. Ensure `lanes.native_only.run_config` and `lanes.native_plus_vervain.run_config` match across `scenario_id`, `seed`, `model_id`, `model_revision`, `tokenizer_revision`, `backend`, `vllm_sha`, and `fixture_id`.
