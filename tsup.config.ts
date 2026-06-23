import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/catalog.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // No sourcemaps in the published tarball — they'd ship the full source and ~4x
  // the package size. Build with `tsup --sourcemap` locally if you need to debug.
  sourcemap: false,
  target: "es2022",
});
