import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit テスト（tests/unit/）。ブラウザ操作はSystem層、表示の初期マークアップは
// Reactの静的レンダーで確認する。Next用のjsx:preserveはテスト内では変換する。
export default defineConfig({
  oxc: { jsx: { runtime: "automatic" } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["tests/server-only.ts"],
    include: ["tests/unit/**/*.test.ts"],
  },
});
