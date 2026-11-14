/**
 * Vervain Judge Replay design tokens as TypeScript constants and CSS custom properties.
 * Calibrated for WCAG AA/AAA contrast on dark architectural obsidian surfaces.
 */

export const VERVAIN_REPLAY_TOKENS = Object.freeze({
  "--vr-bg-canvas": "#0b0b0e",
  "--vr-bg-surface": "#111116",
  "--vr-bg-elevated": "#17171f",
  "--vr-bg-subtle": "#1d1d27",
  "--vr-border-hairline": "#282836",
  "--vr-border-strong": "#3e3e52",
  "--vr-text-primary": "#f3efe6",
  "--vr-text-secondary": "#c8c3b8",
  "--vr-text-tertiary": "#9e988c",
  "--vr-accent-purple": "#a88eff",
  "--vr-accent-purple-strong": "#c2b0ff",
  "--vr-accent-purple-surface": "#221c35",
  "--vr-scope-birch-ink": "#f3efe6",
  "--vr-scope-birch-surface": "#1d2028",
  "--vr-scope-alder-ink": "#eab075",
  "--vr-scope-alder-surface": "#291f17",
  "--vr-alert-ink": "#f6a5a5",
  "--vr-alert-surface": "#261417",
  "--vr-alert-border": "#6e333c",
  "--vr-warn-ink": "#ebd08b",
  "--vr-warn-surface": "#252013",
  "--vr-warn-border": "#635329",
  "--vr-focus-ring": "#b8a2ff",
  "--vr-font-sans":
    '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  "--vr-font-mono":
    '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Monaco, Consolas, monospace',
  "--vr-radius-sm": "3px",
  "--vr-radius-md": "6px",
  "--vr-transition-step": "320ms cubic-bezier(0.22, 1, 0.36, 1)"
} as const);

export type VervainReplayTokenName = keyof typeof VERVAIN_REPLAY_TOKENS;

export const VERVAIN_REPLAY_TOKENS_CSS: string = `:root, [data-vervain-replay-root] {\n${Object.entries(
  VERVAIN_REPLAY_TOKENS
)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join("\n")}\n}\n`;
