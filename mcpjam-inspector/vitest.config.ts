import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Telemetry catalogs are build outputs: fresh before the run and before
    // every watch rerun, however Vitest was started.
    globalSetup: ["../scripts/generate-telemetry-catalogs.mjs"],
    projects: [
      {
        extends: "./server/vitest.config.ts",
        test: {
          name: "server",
          root: "./server",
        },
      },
      {
        extends: "./client/vitest.config.ts",
        test: {
          name: "client",
          root: "./client",
        },
      },
      {
        extends: "./shared/vitest.config.ts",
        test: {
          name: "shared",
          root: "./shared",
        },
      },
      {
        extends: "./src/vitest.config.ts",
        test: {
          name: "src",
          root: "./src",
        },
      },
    ],
  },
});
