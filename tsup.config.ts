import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

// The version the source tag carries comes from package.json, so it cannot drift.
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: ["src/index.ts", "src/catalog.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // No sourcemaps in the published tarball — they'd ship the full source and ~4x
  // the package size. Build with `tsup --sourcemap` locally if you need to debug.
  sourcemap: false,
  target: "es2022",
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
