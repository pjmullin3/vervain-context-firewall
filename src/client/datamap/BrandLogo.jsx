/* From the Vervain product codebase (pjmullin3/vervain ui/audit), pre-existing; see PROVENANCE.md. */
const logo = new URL("./assets/vervain-logo.svg", import.meta.url).href;

/** The heading mark only. Operational Box navigation keeps three intact faces. */
export function BrandLogo({ className = "", decorative = true }) {
  return (
    <img
      className={`heading-mark ${className}`}
      src={logo}
      alt={decorative ? "" : "Vervain"}
      aria-hidden={decorative || undefined}
      width="240"
      height="240"
      draggable={false}
    />
  );
}
