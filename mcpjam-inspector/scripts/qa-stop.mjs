#!/usr/bin/env node

/**
 * Stop the Inspector that `qa:start` started.
 *
 * Usage:
 *   npm run qa:stop -w @mcpjam/inspector -- [--name <slug>]
 *
 * The launcher stops its own children when it exits, so this signals the
 * launcher and waits. Logs and screenshots stay in the session directory.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import {
  isAlive,
  parseQaArgs,
  sessionDir,
  sessionFiles,
} from "./lib/qa-session.mjs";

const STOP_TIMEOUT_MS = 20_000;

async function main() {
  const options = parseQaArgs(process.argv.slice(2));
  const name = options.name ?? "default";
  const files = sessionFiles(sessionDir(name));
  if (!existsSync(files.session)) {
    process.stdout.write(`No QA session "${name}" is running.\n`);
    return;
  }
  const { pid } = JSON.parse(readFileSync(files.session, "utf8"));
  if (isAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 250));
    }
    if (isAlive(pid)) {
      throw new Error(
        `The Inspector (pid ${pid}) is still running after ${STOP_TIMEOUT_MS / 1000}s; stop it with kill ${pid}.`,
      );
    }
  }
  rmSync(files.session);
  process.stdout.write(`Stopped QA session "${name}".\n`);
}

main().catch((error) => {
  process.stderr.write(`qa:stop: ${error.message}\n`);
  process.exitCode = 1;
});
