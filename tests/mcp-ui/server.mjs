import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../..", import.meta.url));
const server = await createServer({
  configFile: false,
  envDir: false,
  envPrefix: [],
  root: resolve(root, "tests/mcp-ui"),
  resolve: { alias: { "@": resolve(root, "src"), "next/link": resolve(root, "tests/mcp-ui/next-link.tsx") } },
  oxc: { jsx: { runtime: "automatic" } },
  server: {
    host: "127.0.0.1", port: 5191, strictPort: true,
    hmr: false,
    fs: { allow: [resolve(root, "src"), resolve(root, "tests/mcp-ui"), resolve(root, "node_modules")] },
  },
});
await server.listen();
