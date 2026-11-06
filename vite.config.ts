import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  // Relative asset paths are required for the packaged app: the production
  // window loads dist/renderer/index.html over file://, where absolute
  // /assets/... URLs resolve to the filesystem root and render a white page.
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    // Keep the terminal runtime and React cacheable across application
    // updates. The entry chunk stays small enough to load quickly while the
    // relatively stable xterm code can be reused by the browser cache.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@xterm/")) return "xterm";
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) return "react";
          return undefined;
        },
      },
    },
  },
});
