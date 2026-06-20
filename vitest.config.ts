import { defineConfig } from "vitest/config";

export default defineConfig({
  // Source files import siblings with explicit `.js` (NodeNext style); map those
  // to `.ts` so vitest can resolve them.
  resolve: { extensionAlias: { ".js": [".ts", ".js"] } },
  test: { include: ["test/**/*.test.ts"] },
});
