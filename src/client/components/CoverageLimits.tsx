/**
 * Responsibility: Displays mediated boundaries alongside explicit unsupported/unmediated
 * exclusions on every receipt view.
 * Trust boundary: Pure presentation component; ensures denominators and exclusions stay
 * visually adjacent to security claims.
 */

export interface CoverageLimitsProps {
  readonly mediatedBoundaries: readonly string[];
  readonly exclusions: readonly string[];
}

const HUMAN_BOUNDARY_LABELS: Readonly<Record<string, string>> = {
  retrieval_to_gemini_context_envelope:
    'Pre-inference context admission into this server-assembled Google Gemini envelope',
  gemini_response_to_browser_release:
    'Nonstreaming response release gate rechecking session authority and policy epoch before reply delivery',
};

const HUMAN_EXCLUSION_LABELS: Readonly<Record<string, string>> = {
  provider_internal_kv_cache_and_weights_unmediated:
    'Google Gemini provider-internal KV cache, weights, and internal scheduling are outside customer visibility and unmediated',
  direct_unmediated_provider_calls_outside_this_server:
    'Direct calls to the Gemini API bypassing this server are unmediated',
  semantic_or_paraphrased_disclosure_beyond_exact_synthetic_planted_value_scan:
    'Release-time text scanning checks exact synthetic planted strings only and does not detect arbitrary semantic paraphrase',
  nonstreaming_full_response_buffering_increases_time_to_first_token:
    'Responses are buffered nonstreaming prior to release gating, trading higher time-to-first-token for pre-release epoch verification',
  in_memory_hash_chain_without_external_checkpoint_does_not_detect_full_store_rollback:
    'In-memory SHA-256 chain detects mutation within this running instance, not full-store rollback or process restart without an external checkpoint',
  synthetic_persona_selector_is_demo_fixture_not_enterprise_authentication:
    'Persona dropdown selects a server-owned synthetic fixture and is not enterprise OIDC/IAM authentication',
  external_tools_databases_and_host_administrators_outside_demo_scope:
    'External agent tools, other databases, and host administrators are outside this prototype scope',
};

export function CoverageLimits({ mediatedBoundaries, exclusions }: CoverageLimitsProps) {
  return (
    <div className="coverage-section" data-testid="coverage-limits">
      <h4>
        Mediated Boundaries ({mediatedBoundaries.length} of {mediatedBoundaries.length} in this app)
      </h4>
      <ul className="compact-list">
        {mediatedBoundaries.map((b) => (
          <li key={b}>
            <span>{HUMAN_BOUNDARY_LABELS[b] ?? b}</span>{' '}
            <span className="mono" style={{ color: 'var(--text-muted)' }}>
              ({b})
            </span>
          </li>
        ))}
      </ul>

      <h4 style={{ marginTop: 10 }}>Explicit Exclusions &amp; Unsupported Paths</h4>
      <ul className="compact-list" data-testid="exclusions-list">
        {exclusions.map((ex) => (
          <li key={ex}>{HUMAN_EXCLUSION_LABELS[ex] ?? ex}</li>
        ))}
      </ul>
    </div>
  );
}
