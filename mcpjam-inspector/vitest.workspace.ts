import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
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
]);
