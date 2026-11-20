import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the "@/*" import alias from tsconfig.json.
  resolve: { tsconfigPaths: true },
  test: { environment: "node" },
});
