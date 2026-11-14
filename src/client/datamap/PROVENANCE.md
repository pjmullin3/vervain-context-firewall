# Provenance

Every `.jsx`, `.mjs` and `.css` file in this folder, plus `assets/`, is copied from the Vervain
product codebase (pjmullin3/vervain, `ui/audit/src`), checkout dated 2026-11-14. They are
pre-existing work, not built during the hackathon. Changes made here: a one-line header comment
per file, and relative imports flattened into this folder (`../GraphSettings.jsx`, `../ui.jsx`,
`../data-strings-model.mjs` now point to `./`).

Files: `DataMap.jsx`, `physics.mjs`, `fluid.mjs`, `topology.mjs`, `layout.mjs`, `shape.mjs`,
`fixtures.mjs`, `datamap.css` (from `ui/audit/src/datamap/`), and `GraphSettings.jsx`, `ui.jsx`,
`BrandLogo.jsx`, `data-strings-model.mjs`, `graph-experience.mjs`, `agent-workspace-model.mjs`,
`assets/vervain-logo.svg`, `assets/vervain-logo-mark.png` (from `ui/audit/src/`).

The `.d.ts` / `.d.mts` files are new type declarations so the TypeScript app can import the
JavaScript modules. New hackathon code lives in `src/client/leakcheck/`.
