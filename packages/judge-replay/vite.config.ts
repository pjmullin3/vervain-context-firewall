import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4179,
    strictPort: true,
    fs: {
      allow: [resolve(import.meta.dirname, "../..")]
    }
  },
  preview: {
    port: 4179,
    strictPort: true
  },
  build: {
    outDir: "build/demo",
    emptyOutDir: true
  }
});
