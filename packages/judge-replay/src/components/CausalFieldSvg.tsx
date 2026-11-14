import React, { useId } from "react";
import { COPY_CONTRACT } from "../copyContract.js";
import type { ReplaySurfaceKind } from "../machine.js";
import type {
  LaneId,
  TimelineStepIndex,
  ValidatedEvidenceBundle
} from "../types.js";

export interface CausalFieldSvgProps {
  readonly validated: ValidatedEvidenceBundle;
  readonly surfaceKind: ReplaySurfaceKind;
  readonly activeLane: LaneId;
  readonly activeStepIndex: TimelineStepIndex;
  readonly onSelectStep: (stepIndex: TimelineStepIndex) => void;
}

// Dedicated horizontal carrier rails (y=164 for Birch, y=322 for Alder) keep moving
// block tokens completely clear of every node text label across all 9 steps.
const BIRCH_RAIL_Y = 164;
const ALDER_RAIL_Y = 322;

const BIRCH_X_BY_STEP: Readonly<Record<TimelineStepIndex, number>> = {
  1: 118,
  2: 118,
  3: 345,
  4: 556,
  5: 616,
  6: 752,
  7: 1005,
  8: 1005,
  9: 1005
};

function compactSvgLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(4, maxChars - 3))}...`;
}

function getAlderCarrierX(
  stepIndex: TimelineStepIndex,
  clippedAtAperture: boolean
): number {
  if (stepIndex === 1) return 72;
  if (stepIndex === 2) return 118;
  if (stepIndex === 3) return 347;
  if (stepIndex === 4) return 556;
  if (stepIndex === 5) return 616;
  if (stepIndex === 6) return 750;
  // Step 7..9: stopped against the left face of the aperture in Vervain, or crosses to backend terminal in Native baseline
  return clippedAtAperture ? 750 : 1005;
}

export function CausalFieldSvg({
  validated,
  surfaceKind,
  activeLane,
  activeStepIndex,
  onSelectStep
}: CausalFieldSvgProps): React.JSX.Element {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const birchPatternId = `vr-birch-ruled-${uid}`;
  const alderPatternId = `vr-alder-hatched-${uid}`;
  const aperturePatternId = `vr-aperture-slit-${uid}`;

  const { bundle, verifierFailed } = validated;
  const lane = bundle.lanes[activeLane];
  const birchLineage =
    bundle.lineage.find((item) => item.role === "request_owner") ?? bundle.lineage[0]!;
  const alderLineage =
    bundle.lineage.find((item) => item.role === "foreign_injected") ?? bundle.lineage[1]!;

  const birchBlock =
    lane.blocks.find((b) => !b.is_foreign_to_request) ?? lane.blocks[0]!;
  const alderBlock =
    lane.blocks.find((b) => b.is_foreign_to_request) ?? lane.blocks[1] ?? lane.blocks[0]!;

  const isVervainLane = activeLane === "native_plus_vervain";
  const isIncompleteOrUnsupported =
    surfaceKind === "incomplete" || surfaceKind === "unsupported";
  const isClippedBeforeDispatch =
    !isIncompleteOrUnsupported &&
    alderBlock.aperture_outcome === "clipped_before_dispatch";
  const foreignReachedBackend =
    !isIncompleteOrUnsupported &&
    lane.summary.foreign_backend_dispatched === true;

  const birchCarrierX = BIRCH_X_BY_STEP[activeStepIndex];
  const alderVisible = activeStepIndex >= 2;
  const alderCarrierX = getAlderCarrierX(activeStepIndex, isClippedBeforeDispatch);

  const apertureEngaged = activeStepIndex >= 6 && !isIncompleteOrUnsupported;
  const clipDecisionActive = activeStepIndex >= 7 && isClippedBeforeDispatch;
  const unmediatedDispatchActive = activeStepIndex >= 7 && foreignReachedBackend;
  const completionActive =
    activeStepIndex >= 8 && lane.summary.allowed_request_completed === true;
  const receiptStepRecorded = lane.steps[8]?.recorded === true;
  const receiptStepHighlighted = activeStepIndex >= 9 && receiptStepRecorded;

  return (
    <section className="vr-field-panel" aria-labelledby={`causal-field-heading-${uid}`}>
      <div className="vr-field-header">
        <div>
          <p className="vr-eyebrow">Causal memory lineage &amp; pre-attention boundary</p>
          <h2 id={`causal-field-heading-${uid}`} className="vr-section-title">
            {lane.label}: request {bundle.policy.request_id} ({bundle.policy.request_scope})
          </h2>
        </div>

        <div className="vr-legend" aria-label="Scope pattern and boundary legend">
          <span className="vr-legend-item">
            <span aria-hidden="true">● ═</span>
            <span>{birchLineage.scope_tag} (horizontal rule · request owner)</span>
          </span>
          <span className="vr-legend-item">
            <span aria-hidden="true">◆ ╱</span>
            <span>{alderLineage.scope_tag} (diagonal hatch · foreign record)</span>
          </span>
          <span className="vr-legend-item">
            <span aria-hidden="true">┤</span>
            <span>Attention read aperture</span>
          </span>
        </div>
      </div>

      <div className="vr-svg-frame">
        <svg
          className="vr-causal-svg"
          viewBox="0 0 1120 436"
          role="img"
          aria-label={`Causal replay diagram for ${lane.label} at step ${activeStepIndex} of 9. ${birchLineage.scope_tag} authorized path and ${alderLineage.scope_tag} injected path entering paged KV memory volume and attention read aperture.`}
          data-testid="causal-field-svg"
        >
          <defs>
            <pattern
              id={birchPatternId}
              width="12"
              height="8"
              patternUnits="userSpaceOnUse"
            >
              <rect width="12" height="8" fill="#1b1e26" />
              <line x1="0" y1="2" x2="12" y2="2" stroke="#f3efe6" strokeOpacity="0.22" strokeWidth="1" />
              <line x1="0" y1="6" x2="12" y2="6" stroke="#f3efe6" strokeOpacity="0.12" strokeWidth="1" />
            </pattern>

            <pattern
              id={alderPatternId}
              width="10"
              height="10"
              patternUnits="userSpaceOnUse"
            >
              <rect width="10" height="10" fill="#271d16" />
              <path
                d="M -2,10 L 10,-2 M 0,12 L 12,0"
                stroke="#eab075"
                strokeOpacity="0.34"
                strokeWidth="1.2"
              />
            </pattern>

            <pattern
              id={aperturePatternId}
              width="8"
              height="12"
              patternUnits="userSpaceOnUse"
            >
              <rect width="8" height="12" fill="#1e1930" />
              <line x1="0" y1="0" x2="8" y2="0" stroke="#a88eff" strokeOpacity="0.26" strokeWidth="1" />
            </pattern>
          </defs>

          {/* Architectural column coordinate headers */}
          <g fontFamily="var(--vr-font-mono)" fontSize="10.5" fill="#9e988c" letterSpacing="0.05em">
            <text x="26" y="26">01 · INGRESS &amp; RETRIEVAL</text>
            <text x="256" y="26">02 · LOGICAL TOKENS</text>
            <text x="476" y="26">03 · PAGED KV VOLUME</text>
            <text x="742" y="26">04 · READ APERTURE</text>
            <text x="914" y="26">05 · BACKEND &amp; RECEIPT</text>
          </g>

          {/* Subtle vertical zone dividers */}
          <g stroke="#242432" strokeWidth="1">
            <line x1="238" y1="14" x2="238" y2="404" />
            <line x1="458" y1="14" x2="458" y2="404" />
            <line x1="728" y1="14" x2="728" y2="404" />
            <line x1="898" y1="14" x2="898" y2="404" />
          </g>

          {/* ZONE 01: IAM & Retrieval Lineage Nodes */}
          <g>
            <rect
              x="22"
              y="56"
              width="202"
              height="82"
              rx="4"
              fill={`url(#${birchPatternId})`}
              stroke={activeStepIndex === 1 ? "#a88eff" : "#f3efe6"}
              strokeOpacity={activeStepIndex === 1 ? 1 : 0.55}
              strokeWidth={activeStepIndex === 1 ? "2" : "1.2"}
            />
            <text x="34" y="78" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#f3efe6">
              ● {birchLineage.scope_tag.toUpperCase()} · IAM ALLOWED
            </text>
            <text x="34" y="98" fontFamily="var(--vr-font-sans)" fontSize="12.5" fontWeight="600" fill="#f3efe6">
              {compactSvgLabel(birchLineage.label, 25)}
            </text>
            <text x="34" y="118" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#c8c3b8">
              {compactSvgLabel(`${bundle.policy.request_id} · ${birchLineage.source_alias}`, 31)}
            </text>
            <line x1="118" y1="138" x2="118" y2={BIRCH_RAIL_Y} stroke="#f3efe6" strokeOpacity="0.45" strokeWidth="1.2" />
          </g>

          <g opacity={activeStepIndex >= 2 ? 1 : 0.48}>
            <polygon
              points="30,214 216,214 224,222 224,294 216,302 30,302 22,294 22,222"
              fill={`url(#${alderPatternId})`}
              stroke={activeStepIndex === 2 ? "#a88eff" : "#eab075"}
              strokeWidth={activeStepIndex === 2 ? "2" : "1.35"}
            />
            <text x="34" y="236" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#eab075">
              ◆ {alderLineage.scope_tag.toUpperCase()} · FOREIGN
            </text>
            <text x="34" y="256" fontFamily="var(--vr-font-sans)" fontSize="12.5" fontWeight="600" fill="#f3efe6">
              Missing retrieval filter
            </text>
            <text x="34" y="276" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#c8c3b8">
              {compactSvgLabel(`${alderLineage.source_alias} -> Birch path`, 31)}
            </text>
            <line x1="118" y1="302" x2="118" y2={ALDER_RAIL_Y} stroke="#eab075" strokeOpacity="0.55" strokeWidth="1.2" />
          </g>

          {/* ZONE 02: Shared Birch Request Context Envelope (Logical Tokens) */}
          <g opacity={activeStepIndex >= 3 ? 1 : 0.52}>
            <rect
              x="250"
              y="52"
              width="194"
              height="294"
              rx="5"
              fill="#121218"
              stroke={activeStepIndex === 3 ? "#a88eff" : "#3e3e52"}
              strokeWidth={activeStepIndex === 3 ? "1.8" : "1"}
            />
            <text x="262" y="72" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#9e988c">
              {compactSvgLabel(`CONTEXT · ${bundle.policy.request_id}`, 29)}
            </text>

            <rect
              x="262"
              y="84"
              width="170"
              height="54"
              rx="3"
              fill={`url(#${birchPatternId})`}
              stroke="#f3efe6"
              strokeOpacity="0.5"
              strokeWidth="1"
            />
            <text x="274" y="106" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#f3efe6">
              ● {birchBlock.token_range}
            </text>
            <text x="274" y="124" fontFamily="var(--vr-font-mono)" fontSize="10" fill="#c8c3b8">
              tag: {birchLineage.scope_tag}
            </text>

            <polygon
              points="268,236 426,236 432,242 432,292 426,298 268,298 262,292 262,242"
              fill={`url(#${alderPatternId})`}
              stroke="#eab075"
              strokeWidth="1.2"
            />
            <text x="274" y="259" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#eab075">
              ◆ {alderBlock.token_range}
            </text>
            <text x="274" y="279" fontFamily="var(--vr-font-mono)" fontSize="10" fill="#f3efe6">
              retained: {alderLineage.scope_tag}
            </text>
          </g>

          {/* ZONE 03: Central Axonometric Paged KV Memory Cube */}
          <g opacity={activeStepIndex >= 4 ? 1 : 0.58}>
            <polygon
              points="476,66 506,46 712,46 682,66"
              fill="#191923"
              stroke={activeStepIndex === 4 || activeStepIndex === 5 ? "#a88eff" : "#4b4b63"}
              strokeWidth="1.2"
            />
            <polygon
              points="682,66 712,46 712,334 682,354"
              fill="#14141d"
              stroke={activeStepIndex === 4 || activeStepIndex === 5 ? "#a88eff" : "#4b4b63"}
              strokeWidth="1.2"
            />
            <rect
              x="476"
              y="66"
              width="206"
              height="288"
              fill="#101016"
              stroke={activeStepIndex === 4 || activeStepIndex === 5 ? "#a88eff" : "#565670"}
              strokeWidth={activeStepIndex === 4 || activeStepIndex === 5 ? "1.8" : "1.25"}
              strokeDasharray={isIncompleteOrUnsupported ? "5 4" : undefined}
            />
            <line x1="476" y1="92" x2="682" y2="92" stroke="#262636" strokeWidth="1" />
            <line x1="476" y1="194" x2="682" y2="194" stroke="#262636" strokeWidth="1" />

            <text x="488" y="84" fontFamily="var(--vr-font-mono)" fontSize="9.5" fontWeight="600" fill="#c8c3b8">
              PAGED KV BLOCK TABLE · SEED {lane.run_config.seed}
            </text>

            {/* Physical KV Slot 0: Allowed Birch Block */}
            <rect
              x="488"
              y="100"
              width="182"
              height="44"
              rx="3"
              fill={`url(#${birchPatternId})`}
              stroke="#f3efe6"
              strokeOpacity="0.7"
              strokeWidth="1.2"
            />
            <text x="498" y="118" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#f3efe6">
              ● {birchBlock.block_alias} ({birchBlock.owner_scope})
            </text>
            <text x="498" y="134" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#c8c3b8">
              alloc_gen: {birchBlock.allocation_generation} · epoch: {bundle.policy.policy_epoch}
            </text>

            {/* Physical KV Slot 1: Foreign Alder Block */}
            <polygon
              points="494,248 664,248 670,254 670,294 664,300 494,300 488,294 488,254"
              fill={`url(#${alderPatternId})`}
              stroke="#eab075"
              strokeWidth="1.35"
            />
            <text x="498" y="268" fontFamily="var(--vr-font-mono)" fontSize="10.5" fontWeight="600" fill="#eab075">
              ◆ {alderBlock.block_alias} ({alderBlock.owner_scope})
            </text>
            <text x="498" y="286" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#f3efe6">
              alloc_gen: {alderBlock.allocation_generation} · foreign block
            </text>
          </g>

          {/* ZONE 05: Attention Backend Dispatch & Completion Plane (drawn before rails so docking slots align cleanly) */}
          <g>
            {/* Upper Chamber: Allowed Birch Backend Read & Completion */}
            <rect
              x="914"
              y="62"
              width="182"
              height="80"
              rx="4"
              fill="#14141c"
              stroke={completionActive && !verifierFailed ? "#a88eff" : "#3e3e52"}
              strokeWidth={completionActive ? "1.8" : "1.1"}
            />
            <text x="926" y="82" fontFamily="var(--vr-font-mono)" fontSize="10" fontWeight="600" fill="#c8c3b8">
              ATTENTION BACKEND
            </text>
            <text x="926" y="101" fontFamily="var(--vr-font-sans)" fontSize="12" fontWeight="600" fill="#f3efe6">
              {isIncompleteOrUnsupported ? "Pending GPU run" : "Birch read admitted"}
            </text>
            <text x="926" y="120" fontFamily="var(--vr-font-mono)" fontSize="10" fill="#c8c3b8">
              {verifierFailed
                ? "[!] Unverified receipt"
                : completionActive
                  ? "✓ Allowed result completed"
                  : isIncompleteOrUnsupported
                    ? "△ Awaiting execution"
                    : `${birchBlock.block_alias} · gen ${birchBlock.allocation_generation}`}
            </text>

            {/* Backend Arrival Slot for Birch Rail */}
            <rect
              x="958"
              y={BIRCH_RAIL_Y - 15}
              width="94"
              height="30"
              rx="15"
              fill="#101016"
              stroke="#343446"
              strokeDasharray="3 3"
              strokeWidth="1"
            />

            {/* Lower Chamber: Foreign Alder Backend Dispatch Outcome */}
            <rect
              x="914"
              y="214"
              width="182"
              height="84"
              rx="4"
              fill={foreignReachedBackend ? "#241b15" : "#121218"}
              stroke={foreignReachedBackend ? "#eab075" : "#3e3e52"}
              strokeDasharray={isClippedBeforeDispatch ? "4 3" : undefined}
              strokeWidth="1.25"
            />
            <text x="926" y="234" fontFamily="var(--vr-font-mono)" fontSize="10" fontWeight="600" fill="#c8c3b8">
              FOREIGN BLOCK DISPATCH
            </text>
            <text
              x="926"
              y="256"
              fontFamily="var(--vr-font-mono)"
              fontSize="11"
              fontWeight="700"
              fill={foreignReachedBackend ? "#eab075" : "#f3efe6"}
            >
              {isIncompleteOrUnsupported
                ? "△ NOT RECORDED"
                : foreignReachedBackend
                  ? "→ DISPATCHED: YES"
                  : "┤ DISPATCHED: NO"}
            </text>
            <text x="926" y="276" fontFamily="var(--vr-font-sans)" fontSize="11" fill="#c8c3b8">
              {isIncompleteOrUnsupported
                ? COPY_CONTRACT.noGpuRecordedBanner
                : foreignReachedBackend
                  ? "Baseline lacks scope guard"
                  : "Stopped before dispatch"}
            </text>

            {/* Backend Arrival Slot for Alder Rail (remains empty when clipped!) */}
            <rect
              x="954"
              y={ALDER_RAIL_Y - 15}
              width="102"
              height="30"
              rx="4"
              fill="#0e0e13"
              stroke={foreignReachedBackend ? "#eab075" : "#2e2e3e"}
              strokeDasharray="3 3"
              strokeWidth="1"
            />
            {!foreignReachedBackend && (
              <text
                x="1005"
                y={ALDER_RAIL_Y + 3}
                textAnchor="middle"
                fontFamily="var(--vr-font-mono)"
                fontSize="9"
                fill="#9e988c"
              >
                {isIncompleteOrUnsupported ? "PENDING" : "EMPTY SLOT"}
              </text>
            )}

            {/* Receipt Seal Footer */}
            <rect
              x="914"
              y="352"
              width="182"
              height="44"
              rx="3"
              fill={verifierFailed ? "#261417" : "#161520"}
              stroke={
                verifierFailed
                  ? "#f6a5a5"
                  : receiptStepHighlighted
                    ? "#a88eff"
                    : "#363648"
              }
              strokeWidth="1.2"
            />
            <text
              x="926"
              y="371"
              fontFamily="var(--vr-font-mono)"
              fontSize="10"
              fontWeight="600"
              fill={verifierFailed ? "#f6a5a5" : "#f3efe6"}
            >
              {verifierFailed
                ? "[!] RECEIPT DIGEST FAILED"
                : receiptStepHighlighted
                  ? "✓ RECEIPT SEALED"
                  : receiptStepRecorded
                    ? "● RECEIPT AT STEP 09"
                    : "△ RECEIPT UNSEALED"}
            </text>
            <text x="926" y="386" fontFamily="var(--vr-font-mono)" fontSize="9.5" fill="#9e988c">
              {bundle.verifier.canonical_sha256.slice(0, 22)}...
            </text>
          </g>

          {/* CONTINUOUS CAUSAL RAILS */}
          {/* Birch allowed rail: x=118 -> Aperture (x=806) -> Backend slot (x=958) */}
          <line
            x1="118"
            y1={BIRCH_RAIL_Y}
            x2="806"
            y2={BIRCH_RAIL_Y}
            stroke="#f3efe6"
            strokeOpacity={activeStepIndex >= 1 ? 0.65 : 0.25}
            strokeWidth="1.75"
          />
          <line
            x1="806"
            y1={BIRCH_RAIL_Y}
            x2="958"
            y2={BIRCH_RAIL_Y}
            stroke={isIncompleteOrUnsupported ? "#575568" : "#f3efe6"}
            strokeDasharray={isIncompleteOrUnsupported ? "4 4" : undefined}
            strokeOpacity={activeStepIndex >= 7 && !isIncompleteOrUnsupported ? 0.9 : 0.35}
            strokeWidth="2"
          />

          {/* Alder foreign rail: x=118 -> Aperture (x=800) */}
          <line
            x1="118"
            y1={ALDER_RAIL_Y}
            x2="800"
            y2={ALDER_RAIL_Y}
            stroke="#eab075"
            strokeDasharray="6 4"
            strokeOpacity={activeStepIndex >= 2 ? 0.82 : 0.22}
            strokeWidth="1.75"
          />

          {/* Alder post-aperture segment: severed in Vervain vs crossing in Native baseline */}
          {isClippedBeforeDispatch ? (
            <g data-testid="foreign-path-clipped-segment">
              <line
                x1="826"
                y1={ALDER_RAIL_Y}
                x2="952"
                y2={ALDER_RAIL_Y}
                stroke="#4d4859"
                strokeDasharray="2 6"
                strokeWidth="1.25"
              />
              <text
                x="888"
                y={ALDER_RAIL_Y - 8}
                textAnchor="middle"
                fontFamily="var(--vr-font-mono)"
                fontSize="9.5"
                fill="#c8c3b8"
              >
                SEVERED · NO READ
              </text>
            </g>
          ) : (
            <g data-testid="foreign-path-unmediated-segment">
              <line
                x1="808"
                y1={ALDER_RAIL_Y}
                x2="954"
                y2={ALDER_RAIL_Y}
                stroke={isIncompleteOrUnsupported ? "#575568" : "#eab075"}
                strokeDasharray={isIncompleteOrUnsupported ? "3 5" : "6 4"}
                strokeOpacity={unmediatedDispatchActive ? 0.92 : 0.32}
                strokeWidth="2"
              />
              <text
                x="882"
                y={ALDER_RAIL_Y - 8}
                textAnchor="middle"
                fontFamily="var(--vr-font-mono)"
                fontSize="9.5"
                fill={isIncompleteOrUnsupported ? "#9e988c" : "#eab075"}
              >
                {isIncompleteOrUnsupported ? "PENDING" : "UNMEDIATED PASS"}
              </text>
            </g>
          )}

          {/* ZONE 04: The Attention Read Aperture (Isometric Cut-Plane) */}
          <g data-testid="attention-aperture-plane">
            <polygon
              points="796,60 822,46 822,350 796,364"
              fill={isVervainLane && !isIncompleteOrUnsupported ? `url(#${aperturePatternId})` : "#15151d"}
              stroke={
                verifierFailed
                  ? "#f6a5a5"
                  : isVervainLane && !isIncompleteOrUnsupported
                    ? "#a88eff"
                    : "#5a5a72"
              }
              strokeWidth={apertureEngaged ? "2.2" : "1.4"}
              strokeDasharray={!isVervainLane || isIncompleteOrUnsupported ? "5 4" : undefined}
            />

            <text
              x="809"
              y="40"
              textAnchor="middle"
              fontFamily="var(--vr-font-mono)"
              fontSize="9.5"
              fontWeight="600"
              fill={isVervainLane ? "#c2b0ff" : "#c8c3b8"}
            >
              {isVervainLane ? "SCOPE + GEN" : "NO GUARD"}
            </text>

            {/* Upper Slit: Allowed Birch comparison */}
            <rect
              x="792"
              y={BIRCH_RAIL_Y - 14}
              width="34"
              height="28"
              rx="2"
              fill="#1c2224"
              stroke="#f3efe6"
              strokeWidth="1.2"
            />
            <rect
              x="777"
              y={BIRCH_RAIL_Y - 35}
              width="64"
              height="16"
              rx="3"
              fill="#0e0e14"
              stroke="#3e3a52"
              strokeWidth="1"
            />
            <text
              x="809"
              y={BIRCH_RAIL_Y - 23.5}
              textAnchor="middle"
              fontFamily="var(--vr-font-mono)"
              fontSize="9.5"
              fontWeight="600"
              fill="#f3efe6"
            >
              {isIncompleteOrUnsupported ? "PENDING" : "MATCH"}
            </text>

            {/* Lower Slit: Critical Foreign Mismatch Boundary */}
            {isClippedBeforeDispatch ? (
              <g data-testid="aperture-mismatch-cut">
                <rect
                  x="790"
                  y={ALDER_RAIL_Y - 18}
                  width="36"
                  height="36"
                  rx="2"
                  fill="#291b2e"
                  stroke="#a88eff"
                  strokeWidth="2"
                />
                {/* Orthogonal T-bar cut symbol */}
                <line
                  x1="814"
                  y1={ALDER_RAIL_Y - 13}
                  x2="814"
                  y2={ALDER_RAIL_Y + 13}
                  stroke="#f3efe6"
                  strokeWidth="2.6"
                />
                <line
                  x1="794"
                  y1={ALDER_RAIL_Y}
                  x2="814"
                  y2={ALDER_RAIL_Y}
                  stroke="#eab075"
                  strokeWidth="2.2"
                />
                <rect
                  x="769"
                  y={ALDER_RAIL_Y - 40}
                  width="80"
                  height="17"
                  rx="3"
                  fill="#171222"
                  stroke="#7b68bd"
                  strokeWidth="1"
                />
                <text
                  x="809"
                  y={ALDER_RAIL_Y - 28}
                  textAnchor="middle"
                  fontFamily="var(--vr-font-mono)"
                  fontSize="10"
                  fontWeight="700"
                  fill="#f3efe6"
                >
                  ┤ CLIPPED
                </text>
                <text
                  x="809"
                  y="381"
                  textAnchor="middle"
                  fontFamily="var(--vr-font-mono)"
                  fontSize="9.5"
                  fill="#eab075"
                >
                  birch != alder
                </text>
              </g>
            ) : (
              <g>
                <rect
                  x="792"
                  y={ALDER_RAIL_Y - 14}
                  width="34"
                  height="28"
                  rx="2"
                  fill="#221c18"
                  stroke="#eab075"
                  strokeDasharray="3 3"
                  strokeWidth="1.2"
                />
                <rect
                  x="783"
                  y={ALDER_RAIL_Y - 35}
                  width="52"
                  height="16"
                  rx="3"
                  fill="#15110e"
                  stroke="#6b5036"
                  strokeWidth="1"
                />
                <text
                  x="809"
                  y={ALDER_RAIL_Y - 23.5}
                  textAnchor="middle"
                  fontFamily="var(--vr-font-mono)"
                  fontSize="9.5"
                  fill="#eab075"
                >
                  {isIncompleteOrUnsupported ? "N/A" : "OPEN"}
                </text>
              </g>
            )}
          </g>

          {/* SIGNATURE DETERMINISTIC CARRIERS */}
          <g
            className="vr-carrier-motion"
            style={{ transform: `translate(${birchCarrierX}px, ${BIRCH_RAIL_Y}px)` }}
            data-testid="birch-lineage-carrier"
          >
            <rect
              x="-34"
              y="-12"
              width="68"
              height="24"
              rx="12"
              fill={`url(#${birchPatternId})`}
              stroke="#f3efe6"
              strokeWidth="1.6"
            />
            <text
              x="0"
              y="3.5"
              textAnchor="middle"
              fontFamily="var(--vr-font-mono)"
              fontSize="9.5"
              fontWeight="700"
              fill="#f3efe6"
            >
              ● birch
            </text>
          </g>

          <g
            className="vr-carrier-motion"
            style={{
              transform: `translate(${alderCarrierX}px, ${ALDER_RAIL_Y}px)`,
              opacity: alderVisible ? 1 : 0
            }}
            data-testid="alder-lineage-carrier"
          >
            <polygon
              points="-34,-12 30,-12 36,-6 36,6 30,12 -34,12 -40,6 -40,-6"
              fill={`url(#${alderPatternId})`}
              stroke={clipDecisionActive ? "#a88eff" : "#eab075"}
              strokeWidth="1.8"
            />
            <text
              x="-2"
              y="3.5"
              textAnchor="middle"
              fontFamily="var(--vr-font-mono)"
              fontSize="9.5"
              fontWeight="700"
              fill="#eab075"
            >
              ◆ alder
            </text>
          </g>

          {/* Bottom Evidence Texture Bar inside SVG */}
          <text x="26" y="416" fontFamily="var(--vr-font-mono)" fontSize="10" fill="#9e988c">
            vLLM {bundle.software.vllm_sha} · {bundle.software.runtime_selected_backend} ·{" "}
            {bundle.gpu_run_recorded
              ? `${bundle.hardware.gpu_count}x ${bundle.hardware.gpu_model}`
              : COPY_CONTRACT.noGpuRecordedBanner}
          </text>
        </svg>
      </div>

      {/* Accessible Interactive Stage Readout Strip */}
      <div className="vr-stage-readout-grid" role="group" aria-label="Causal transformation stages">
        <button
          type="button"
          className={`vr-stage-card vr-stage-card--birch ${activeStepIndex <= 2 ? "vr-stage-card--active" : ""}`}
          onClick={() => onSelectStep(2)}
          aria-label={`Ingress and retrieval defect: IAM allowed ${birchLineage.scope_tag}; missing predicate injected ${alderLineage.source_alias} (${alderLineage.scope_tag})`}
        >
          <span className="vr-stage-card-label">01 · Ingress &amp; Defect</span>
          <span className="vr-stage-card-value">
            ● {birchLineage.scope_tag} allowed · ◆ {alderLineage.scope_tag} injected
          </span>
        </button>

        <button
          type="button"
          className={`vr-stage-card vr-stage-card--alder ${activeStepIndex >= 3 && activeStepIndex <= 5 ? "vr-stage-card--active" : ""}`}
          onClick={() => onSelectStep(4)}
          aria-label={`Paged KV memory volume: ${birchBlock.block_alias} owned by ${birchBlock.owner_scope} and ${alderBlock.block_alias} owned by ${alderBlock.owner_scope}, generation ${alderBlock.allocation_generation}`}
        >
          <span className="vr-stage-card-label">02 · Paged KV Blocks</span>
          <span className="vr-stage-card-value">
            {birchBlock.block_alias} (birch) + {alderBlock.block_alias} (alder · gen {alderBlock.allocation_generation})
          </span>
        </button>

        <button
          type="button"
          className={`vr-stage-card ${activeStepIndex === 6 || activeStepIndex === 7 ? "vr-stage-card--active" : ""}`}
          onClick={() => onSelectStep(7)}
          aria-label={`Attention read aperture outcome: ${lane.summary.scope_decision_label}`}
        >
          <span className="vr-stage-card-label">03 · Attention Aperture</span>
          <span className="vr-stage-card-value">
            {verifierFailed
              ? "[!] Unverified receipt"
              : isIncompleteOrUnsupported
                ? `△ ${lane.summary.scope_decision_label}`
                : isClippedBeforeDispatch
                  ? `┤ ${alderBlock.block_alias} stopped before dispatch`
                  : `→ ${alderBlock.block_alias} unmediated in baseline`}
          </span>
        </button>

        <button
          type="button"
          className={`vr-stage-card ${activeStepIndex >= 8 ? "vr-stage-card--active" : ""}`}
          onClick={() => onSelectStep(8)}
          aria-label={`Completion and receipt: allowed Birch completion ${String(lane.summary.allowed_request_completed)}`}
        >
          <span className="vr-stage-card-label">04 · Allowed Completion</span>
          <span className="vr-stage-card-value">
            {verifierFailed
              ? "[!] Outcome withheld (digest failed)"
              : lane.summary.allowed_request_completed === null
                ? `△ ${COPY_CONTRACT.noGpuRecordedBanner}`
                : lane.summary.allowed_request_completed
                  ? `✓ Birch request completed (${birchBlock.block_alias})`
                  : "Birch request incomplete"}
          </span>
        </button>
      </div>
    </section>
  );
}
