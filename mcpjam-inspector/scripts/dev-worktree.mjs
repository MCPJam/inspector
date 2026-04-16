#!/usr/bin/env node

/**
 * Launch a dev environment on offset ports so multiple worktrees can run simultaneously.
 *
 * Usage:
 *   npm run dev:worktree -- <instance>
 *   npm run dev:worktree -- <instance> staging
 *   npm run dev:worktree -- <instance> preview <viteConvexUrl> <convexHttpUrl>
 *
 * Ports:  client = 5173 + instance,  server = 6274 + instance
 */

import { spawn } from "node:child_process";

const instance = Number(process.argv[2]);
const backendTarget = process.argv[3] ?? "local";
const previewViteConvexUrl = process.argv[4];
const previewConvexHttpUrl = process.argv[5];

if (!Number.isInteger(instance) || instance < 1) {
  console.error("Usage:  npm run dev:worktree -- <instance>");
  console.error("        instance must be a positive integer (1, 2, 3, …)");
  process.exit(1);
}

const supportedTargets = new Set(["local", "staging", "preview"]);
if (!supportedTargets.has(backendTarget)) {
  console.error(
    "Usage: npm run dev:worktree -- <instance> [local|staging|preview]",
  );
  process.exit(1);
}

const clientPort = 5173 + instance;
const serverPort = 6274 + instance;

function resolveBackendEnv() {
  if (backendTarget === "local") {
    return {};
  }

  if (backendTarget === "staging") {
    const viteConvexUrl = process.env.MCPJAM_STAGING_VITE_CONVEX_URL;
    const convexHttpUrl = process.env.MCPJAM_STAGING_CONVEX_HTTP_URL;

    if (!viteConvexUrl || !convexHttpUrl) {
      console.error(
        "Staging target requires MCPJAM_STAGING_VITE_CONVEX_URL and MCPJAM_STAGING_CONVEX_HTTP_URL.",
      );
      process.exit(1);
    }

    return {
      VITE_CONVEX_URL: viteConvexUrl,
      CONVEX_HTTP_URL: convexHttpUrl,
    };
  }

  if (!previewViteConvexUrl || !previewConvexHttpUrl) {
    console.error(
      "Preview target requires explicit VITE_CONVEX_URL and CONVEX_HTTP_URL arguments.",
    );
    process.exit(1);
  }

  return {
    VITE_CONVEX_URL: previewViteConvexUrl,
    CONVEX_HTTP_URL: previewConvexHttpUrl,
  };
}

const backendEnv = resolveBackendEnv();

console.log(
  `\n🌲 Worktree instance ${instance}  →  client :${clientPort}  server :${serverPort}  backend ${backendTarget}\n`,
);

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    CLIENT_PORT: String(clientPort),
    SERVER_PORT: String(serverPort),
    VITE_API_BASE_URL: `http://localhost:${serverPort}`,
    WEB_ALLOWED_ORIGINS: `http://localhost:${clientPort},http://127.0.0.1:${clientPort}`,
    ...backendEnv,
  },
});

// Forward signals so concurrently's children are cleaned up
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", (code) => process.exit(code ?? 1));
