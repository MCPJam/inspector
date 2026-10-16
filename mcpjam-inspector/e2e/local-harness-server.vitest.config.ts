import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import base from "../server/vitest.config";
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    root: fileURLToPath(new URL("..", import.meta.url)),
    include: ["e2e/fixtures/local-harness-server.test.ts"],
    setupFiles: [
      fileURLToPath(new URL("../server/test/setup.ts", import.meta.url)),
    ],
    maxWorkers: 1,
  },
});
