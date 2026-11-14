/**
 * Responsibility: Safe shared application constants, explicit boundary identifiers,
 * exclusion statements, and the exact Scoped Attention limitation notice.
 * Trust boundary: Shared between client and server; must never read process.env or hold secrets.
 */

export const APP_TITLE = 'Vervain Context Firewall';
export const APP_SUBTITLE = 'proposed hackathon feature';
export const BUILD_ID = 'vervain-cf-0.1.0-carbon';
export const RECEIPT_SCHEMA_VERSION = 'vervain.context-firewall.receipt.v1';
export const LEDGER_EVENT_SCHEMA_VERSION = 'vervain.context-firewall.event.v1';

export const DESTINATION_GEMINI_CONTEXT = 'gemini.context' as const;
export type DeclaredDestination = typeof DESTINATION_GEMINI_CONTEXT;

export const ALLOWED_CLASSIFICATIONS_BY_DESTINATION: Readonly<
  Record<DeclaredDestination, readonly string[]>
> = {
  'gemini.context': ['customer-commercial'],
};

export const MAX_ADMITTED_CHUNKS = 4;
export const MAX_CHUNK_UTF8_BYTES = 4096;
export const MAX_REQUEST_BODY_BYTES = 8192;

export const MEDIATED_BOUNDARIES = Object.freeze([
  'retrieval_to_gemini_context_envelope',
  'gemini_response_to_browser_release',
] as const);

export const BOUNDARY_LIMIT_NOTE = "Only this app's context and reply paths";

export const RECEIPT_EXCLUSIONS = Object.freeze([
  'provider_internal_kv_cache_and_weights_unmediated',
  'direct_unmediated_provider_calls_outside_this_server',
  'semantic_or_paraphrased_disclosure_beyond_exact_synthetic_planted_value_scan',
  'nonstreaming_full_response_buffering_increases_time_to_first_token',
  'in_memory_hash_chain_without_external_checkpoint_does_not_detect_full_store_rollback',
  'synthetic_persona_selector_is_demo_fixture_not_enterprise_authentication',
  'external_tools_databases_and_host_administrators_outside_demo_scope',
] as const);

export const SCOPED_ATTENTION_LIMITATION_LABEL =
  'Reference scoped-attention proof. Not integrated with Gemini internals or a production vLLM attention backend. No latency or isolation claim.';
