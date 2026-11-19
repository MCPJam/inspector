#!/usr/bin/env node

/**
 * Start a local Inspector on an agent environment and sign a browser in, so a
 * QA run starts from a signed-in screen instead of from setup.
 *
 * Usage:
 *   npm run qa:start -w @mcpjam/inspector -- --bundle <bundle.json> [--local] [--headed]
 *   npm run qa:start -w @mcpjam/inspector -- --environment <environment.json> --grant <grant.json>
 *       [--profile <file>] [--open <app path>] [--expect-server <name>] [--name <slug>] [--local] [--headed]
 *
 * The bundle is what the agent-environments MCP server's `get_environment`
 * returns: the profile, flag answers and a sign-in grant in one file. The
 * other form takes the backend CLI's files (`agent-env up` and
 * `agent-env sign-in --grant`). Ready means a real browser, signed in as the
 * grant's user, shows the intended screen: for a seeded workspace, with its
 * saved server listed. A backend that was provisioned correctly doesn't count
 * until then.
 *
 * The app starts in hosted mode, as on app.mcpjam.com. `--local` starts it the
 * way `npx @mcpjam/inspector` runs on a user's machine instead, for what only
 * local mode has (stdio servers, attaching a dev command): this script picks
 * the access token the local app requires, opens the access link in the
 * browser and keeps the token in the session folder, never printing it.
 *
 * Prints one JSON object: the instance URLs, the screen it opened, a storage
 * state for your next browser context, a screenshot, the log and how to stop.
 * Run it again with a new grant (or a fresh bundle) to sign in another
 * context; it reuses the running instance. Nothing secret is printed.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessLink, createLaunchToken } from "../bin/access-link.mjs";
import {
  checkMode,
  isAlive,
  isReady,
  localProfile,
  parseInstanceLine,
  parseQaArgs,
  profileWithFlags,
  readGrant,
  requireProfile,
  resolveQaInputs,
  sessionDir,
  sessionFiles,
} from "./lib/qa-session.mjs";

const inspectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STARTUP_TIMEOUT_MS = 240_000;
// The server's watcher stays up after a crash at startup, so a crash in the
// log with no health answer for this long means it isn't coming back.
const CRASH_GRACE_MS = 15_000;
const SERVER_CRASH =
  /^\[server\].*\b(SyntaxError|TypeError|ReferenceError|Error \[ERR_|ERR_MODULE_NOT_FOUND)/m;
const READY_TIMEOUT_MS = 60_000;
// First-visit announcements that cover the page; dismissed once so the saved
// storage state doesn't show them again.
const ANNOUNCEMENT_BUTTONS = ["Got it", "Keep dark"];
const ANNOUNCEMENT_SETTLE_MS = 4_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** The log's last lines with URLs cut at their query, for error messages. */
function logTail(path) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() && !/link private/i.test(line))
    .slice(-12)
    .map((line) => line.replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, "$1?…"))
    .join("\n");
}

async function responds(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function runningSession(files) {
  if (!existsSync(files.session)) return null;
  const session = JSON.parse(readFileSync(files.session, "utf8"));
  if (!isAlive(session.pid)) return null;
  return (await responds(`${session.server}/health`)) ? session : null;
}

async function startInspector(inputs, files) {
  // Local mode's launcher takes the token from the environment when it's
  // set, so this script knows it without reading the access link from the log.
  const accessToken = inputs.local ? createLaunchToken({}) : undefined;
  const log = openSync(files.log, "w", 0o600);
  const child = spawn(
    process.execPath,
    [
      join(inspectorDir, "scripts", "dev-worktree.mjs"),
      "auto",
      "--no-worker",
      "--env-file",
      inputs.profile,
    ],
    {
      cwd: inspectorDir,
      detached: true,
      stdio: ["ignore", log, log],
      env: accessToken
        ? { ...process.env, MCPJAM_SESSION_TOKEN: accessToken }
        : process.env,
    },
  );
  child.unref();
  closeSync(log);

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let ports = null;
  let crashSeenAt = null;
  while (Date.now() < deadline) {
    if (!isAlive(child.pid)) {
      throw new Error(
        `The Inspector exited during startup. Log (${files.log}):\n${logTail(files.log)}`,
      );
    }
    const logText = readFileSync(files.log, "utf8");
    ports ??= parseInstanceLine(logText);
    if (
      ports &&
      (await responds(`${ports.server}/health`)) &&
      (await responds(ports.client))
    ) {
      const session = {
        name: inputs.name,
        pid: child.pid,
        ...ports,
        profile: inputs.profile,
        startedAt: new Date().toISOString(),
        ...(accessToken ? { accessToken } : {}),
      };
      writeFileSync(files.session, JSON.stringify(session, null, 2) + "\n", {
        mode: 0o600,
      });
      return session;
    }
    if (SERVER_CRASH.test(logText)) {
      crashSeenAt ??= Date.now();
      if (Date.now() - crashSeenAt > CRASH_GRACE_MS) {
        process.kill(child.pid, "SIGTERM");
        throw new Error(
          `The Inspector's server crashed during startup. Log (${files.log}):\n${logTail(files.log)}`,
        );
      }
    }
    await sleep(1_000);
  }
  process.kill(child.pid, "SIGTERM");
  throw new Error(
    `The Inspector didn't answer within ${STARTUP_TIMEOUT_MS / 1000}s. Log (${files.log}):\n${logTail(files.log)}`,
  );
}

async function launchBrowser(headed) {
  const require = createRequire(join(inspectorDir, "package.json"));
  const { chromium } = require("playwright");
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    if (/Executable doesn't exist/i.test(error.message)) {
      throw new Error(
        "Playwright's Chromium isn't installed. Run `npx playwright install chromium` in mcpjam-inspector, then run qa:start again.",
      );
    }
    throw error;
  }
}

async function signInAndOpen(session, inputs, grant, files) {
  const browser = await launchBrowser(inputs.headed);
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 900 },
    });
    const page = await context.newPage();
    // The app saves the access link's token in local storage on load, so the
    // storage state carries it to the next context.
    await page.goto(
      session.accessToken
        ? createAccessLink(session.client, session.accessToken)
        : session.client,
      { waitUntil: "domcontentloaded" },
    );
    const response = await context.request.post(
      `${session.client}/user_management/authenticate`,
      {
        headers: {
          Origin: session.client,
          Referer: `${session.client}/`,
          Accept: "application/json",
        },
        data: {
          client_id: grant.clientId,
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
        },
      },
    );
    if (!response.ok()) {
      const reason = /"error_description"\s*:\s*"([^"]*)"/.exec(
        await response.text(),
      )?.[1];
      throw new Error(
        `The instance refused the grant (HTTP ${response.status()}${reason ? `: ${reason}` : ""}). A grant works once; get a new one and run qa:start again.`,
      );
    }
    const opened = `${session.client}${inputs.open}`;
    await page.goto(opened, { waitUntil: "domcontentloaded" });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let text = "";
    while (Date.now() < deadline) {
      text = await page.locator("body").innerText();
      if (
        isReady(text, { email: grant.email, expectServer: inputs.expectServer })
      ) {
        break;
      }
      await sleep(500);
    }
    await page.screenshot({ path: files.screenshot });
    if (
      !isReady(text, { email: grant.email, expectServer: inputs.expectServer })
    ) {
      throw new Error(
        `Signed in, but ${opened} didn't show ${inputs.expectServer ? `the "${inputs.expectServer}" server for ` : ""}${grant.email} within ${READY_TIMEOUT_MS / 1000}s. Screenshot: ${files.screenshot}`,
      );
    }
    // Announcements slide in a moment after the page settles.
    const settleUntil = Date.now() + ANNOUNCEMENT_SETTLE_MS;
    while (Date.now() < settleUntil) {
      for (const name of ANNOUNCEMENT_BUTTONS) {
        const button = page.getByRole("button", { name, exact: true }).first();
        if (await button.isVisible()) await button.click();
      }
      await sleep(500);
    }
    await page.screenshot({ path: files.screenshot });
    await context.storageState({ path: files.storageState });
    chmodSync(files.storageState, 0o600);
    return opened;
  } finally {
    await browser.close();
  }
}

async function main() {
  const inputs = resolveQaInputs(parseQaArgs(process.argv.slice(2)));
  const grant = inputs.grant ?? readGrant(inputs.grantPath);
  const dir = sessionDir(inputs.name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const files = sessionFiles(dir);

  const reused = await runningSession(files);
  requireProfile(inputs, Boolean(reused));
  checkMode(reused, inputs);
  if (!reused) {
    let profileText = null;
    if (inputs.bundle) {
      writeFileSync(
        files.flags,
        JSON.stringify(inputs.bundle.flags, null, 2) + "\n",
        { mode: 0o600 },
      );
      profileText = profileWithFlags(inputs.bundle.profile, files.flags);
    }
    if (inputs.local) {
      profileText = localProfile(
        profileText ?? readFileSync(inputs.profile, "utf8"),
      );
    }
    if (profileText) {
      writeFileSync(files.profile, profileText, { mode: 0o600 });
      inputs.profile = files.profile;
    }
  }
  const session = reused ?? (await startInspector(inputs, files));
  const opened = await signInAndOpen(session, inputs, grant, files);
  process.stdout.write(
    JSON.stringify(
      {
        ready: true,
        reusedInstance: Boolean(reused),
        mode: session.accessToken ? "local" : "hosted",
        client: session.client,
        server: session.server,
        opened,
        signedInAs: grant.email,
        storageState: files.storageState,
        screenshot: files.screenshot,
        log: files.log,
        stop: `npm run qa:stop -w @mcpjam/inspector -- --name ${inputs.name}`,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`qa:start: ${error.message}\n`);
  process.exitCode = 1;
});
