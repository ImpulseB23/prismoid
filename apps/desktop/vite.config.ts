import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "url";

export default defineConfig(({ mode }) => ({
  // vitest runs under vite's serve command, where the solid plugin would add
  // its hot-reload runtime to every component. node's module runner cannot
  // load that virtual import on windows, and tests have nothing to reload.
  plugins: [solid({ hot: mode !== "test" })],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "esnext",
  },
  test: {
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "./coverage",
    },
  },
}));
