# Accessibility & Claim Boundaries

## Accessibility Verification

1. **WCAG AA contrast (`>= 4.5:1`)**:
   - Primary ivory text (`#f3efe6`) on canvas (`#0b0b0e`) and surface (`#111116`): `> 15:1`
   - Secondary warm stone (`#c8c3b8`) on surface (`#111116`): `> 10:1`
   - Tertiary metadata (`#9e988c`) on surface (`#111116`): `> 6.2:1`
   - Vervain purple accent (`#a88eff`) on purple surface (`#221c35`) / canvas: `> 5.8:1`
   - Alder scope mineral ochre (`#eab075`) on Alder surface (`#291f17`) / surface: `> 7.5:1`
   - Verified automatically in Chromium via Playwright computed-style luminance tests (`tests/e2e/replay.spec.ts`).
2. **No color-only status**:
   - `scope:birch` (request owner): solid circle glyph (`●`), rounded rectangle frame, horizontal parallel ruling SVG pattern, solid trajectory line, explicit `scope:birch` text label.
   - `scope:alder` (foreign injected record): diamond glyph (`◆`), chamfered octagon frame, 45-degree diagonal cross-hatch SVG pattern, dashed trajectory line, explicit `scope:alder` text label.
   - Aperture stop: orthogonal T-bar (`┤ CLIPPED`) and severed downstream segment.
   - Alerts and warnings: `[!]` double-border frame for verification failures; `△` dashed-border frame for incomplete/stale artifacts; `[/]` for unsupported surfaces.
3. **Keyboard operation**:
   - `Tab` / `Shift+Tab` traverses status action, playback buttons, mode toggle, causal stage cards, active timeline step, and paired lane actions with a high-contrast `2px solid #b8a2ff` focus outline.
   - `ArrowLeft` / `ArrowRight` / `Home` / `End` scrubs across steps `1..9` with roving `tabIndex`.
   - `Escape` closes `ReceiptDrawer` and restores focus to `Open exact receipt`.
4. **Reduced motion**:
   - Honors `@media (prefers-reduced-motion: reduce)` and `forceReducedMotion` prop by setting all transition durations to `0ms` while preserving every discrete causal step state.
   - Zero continuous or ambient background animation in any mode.
5. **Responsive range**:
   - Tested at `360px` width (stacked paired comparison cards, single-column timeline steps, stage readout strip, zero horizontal page overflow) through `1440px` and `1920px` presentation screens.

## Locked Copy & Claim Boundaries

- **Primary line**: `IAM ends at access. Vervain keeps identity attached through model memory.`
- **Technical line**: `A server-owned scope follows each request into vLLM. Before the selected attention backend reads paged KV, Vervain compares the request scope with physical block ownership and allocation generation.`
- **Conditional outcome line** (rendered only when `outcomeClaimEligible === true`): `Foreign block stopped before backend dispatch. Allowed request completed.`
- **Limit line** (rendered beside the outcome at `0.9375rem` body size, never in fine print): `Controlled internal fault injection on the named configuration. Other backends and provider-internal memory are not mediated.`
- **Disallowed unbounded claims** (enforced by `scripts/security-scan.mjs` and unit tests): `proves`, `guarantees`, `secure`, `compliant`, `certified`, `production ready`, `zero overhead`, `all engines`.
