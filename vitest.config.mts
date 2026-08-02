import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit テスト（tests/unit/）の設定。対象は純粋関数のみ（ブラウザ API が要るものは
// System 層で担保する）。Integration 層を足すときは include を分けて別プロジェクト化する。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
  },
});
