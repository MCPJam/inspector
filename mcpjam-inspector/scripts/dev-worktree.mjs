#!/usr/bin/env node

/**
 * Launch a dev environment on offset ports so multiple worktrees can run simultaneously.
 *
 * Usage:  npm run dev:worktree -- <instance>
 *
 * Ports:  client = 5173 + instance,  server = 6274 + instance
 */

import { spawn } from "node:child_process";

const instance = Number(process.argv[2]);

if (!Number.isInteger(instance) || instance < 1) {
  console.error("Usage:  npm run dev:worktree -- <instance>");
  console.error("        instance must be a positive integer (1, 2, 3, …)");
  process.exit(1);
}

const clientPort = 5173 + instance;
const serverPort = 6274 + instance;

console.log(
  `\n🌲 Worktree instance ${instance}  →  client :${clientPort}  server :${serverPort}\n`,
);

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    CLIENT_PORT: String(clientPort),
    SERVER_PORT: String(serverPort),
    VITE_API_BASE_URL: `http://localhost:${serverPort}`,
    WEB_ALLOWED_ORIGINS: `http://localhost:${clientPort},http://127.0.0.1:${clientPort}`,
  },
});

// Forward signals so concurrently's children are cleaned up
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}

child.on("exit", (code) => process.exit(code ?? 1));
