import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } }, test: {
  environment: "node", setupFiles: ["tests/server-only.ts"], include: ["tests/mcp/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false,
} });
