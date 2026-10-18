import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: { input: { main: fileURLToPath(new URL("./web/index.html", import.meta.url)),
      legacy: fileURLToPath(new URL("./web/legacy.html", import.meta.url)) } },
  },
});
