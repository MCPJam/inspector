import os from "node:os";
import { defineConfig } from "vitest/config";

// Size the fork pool to the machine's memory as well as its cores.
//
// `npm test` sets NODE_OPTIONS=--max-old-space-size=6144 for the main Vitest
// process, and every fork worker inherits it. With the default pool (cores
// minus one) a 4 vCPU / 16 GB CI runner allowed three 6 GB workers plus the
// 6 GB main process, 24 GB of heap on 16 GB of RAM. V8 only collects hard as
// it nears its cap, so a heavy file let a worker grow until the kernel killed
// it: "Worker exited unexpectedly" with every test passed.
//
// A worker's own flag overrides NODE_OPTIONS, so workers get a smaller cap,
// and only as many run as fit next to the main process.
const MAIN_HEAP_MB = 6144;
const WORKER_HEAP_MB = 3072;
// Per-worker memory outside the V8 heap (jsdom, buffers, native modules).
const WORKER_OVERHEAD_MB = 512;
const RESERVED_MB = 1024;
const totalMb = os.totalmem() / 2 ** 20;
const workersByMemory = Math.floor(
  (totalMb - MAIN_HEAP_MB - RESERVED_MB) / (WORKER_HEAP_MB + WORKER_OVERHEAD_MB),
);
const workersByCpu = os.availableParallelism() - 1;
const maxWorkers = Math.max(1, Math.min(workersByCpu, workersByMemory));
const execArgv = [`--max-old-space-size=${WORKER_HEAP_MB}`];

export default defineConfig({
  test: {
    // Telemetry catalogs are build outputs: fresh before the run and before
    // every watch rerun, however Vitest was started.
    globalSetup: ["../scripts/generate-telemetry-catalogs.mjs", "./scripts/patch-harness-approvals.mjs"],
    maxWorkers,
    projects: [
      {
        extends: "./server/vitest.config.ts",
        test: {
          name: "server",
          root: "./server",
          execArgv,
        },
      },
      {
        extends: "./client/vitest.config.ts",
        test: {
          name: "client",
          root: "./client",
          execArgv,
        },
      },
      {
        extends: "./shared/vitest.config.ts",
        test: {
          name: "shared",
          root: "./shared",
          execArgv,
        },
      },
      {
        extends: "./src/vitest.config.ts",
        test: {
          name: "src",
          root: "./src",
          execArgv,
        },
      },
      {
        extends: "./lib/vitest.config.ts",
        test: {
          name: "lib",
          root: "./lib",
          execArgv,
        },
      },
    ],
  },
});
