import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(pkgRoot, "dist");

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

execFileSync(
  resolve(pkgRoot, "node_modules/.bin/tsc"),
  ["-p", resolve(pkgRoot, "tsconfig.build.json")],
  { stdio: "inherit", cwd: pkgRoot }
);

cpSync(resolve(pkgRoot, "src/styles/tokens.css"), resolve(distDir, "tokens.css"));
cpSync(resolve(pkgRoot, "src/styles/replay.css"), resolve(distDir, "styles.css"));

console.log("Built @vervain/judge-replay to dist/ (ESM + .d.ts + CSS tokens & styles).");
