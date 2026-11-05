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
  },
});
