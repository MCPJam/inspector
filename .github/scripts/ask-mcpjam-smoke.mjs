#!/usr/bin/env node
/**
 * Tokenless Ask MCPJam smoke test.
 *
 * Runs ONE signed-in Ask MCPJam turn through a self-hosted Inspector — the
 * same shape as `npx @mcpjam/inspector` on a laptop — with NO
 * `INSPECTOR_SERVICE_TOKEN` in its environment, and asserts the turn streams
 * text and finishes.
 *
 * Why this exists: since v3.12.2 every self-hosted install refused every Ask
 * MCPJam turn ("INSPECTOR_SERVICE_TOKEN is not set, so this server cannot
 * attest an MCPJam-paid agent turn"), for a week, without paging anyone. CI
 * and the hosted app both HAVE the token, so nothing we ran looked like what
 * our users run. This does.
 *
 * A passing turn proves the platform-billing claim was honoured end to end:
 * the Inspector refuses any step the backend did not confirm as MCPJam-paid
 * (`x-mcpjam-platform-paid`), so text deltas plus a `finish` chunk cannot come
 * back from a claim that silently fell onto the customer rail.
 *
 * Steps:
 *   1. Install the Inspector: from local tarballs (`INSPECTOR_TARBALLS`, the
 *      release's packed build) or straight from npm (`INSPECTOR_NPM_SPEC`).
 *   2. Start it non-hosted, without the service token, and read the local
 *      access link it prints — the readiness signal a user would see.
 *   3. Mint a first-party AuthKit session for the canary user through the
 *      WorkOS user-management API (password grant when
 *      `ASK_MCPJAM_CANARY_PASSWORD` is set, Magic Auth otherwise).
 *   4. POST one turn to `/api/web/mcpjam-agent` and read the stream.
 *
 * Env:
 *   INSPECTOR_TARBALLS          space-separated tarball paths (pack mode), or
 *   INSPECTOR_NPM_SPEC          e.g. `@mcpjam/inspector@3.13.0` (npm mode)
 *   CONVEX_URL                  client API URL (`/api/query`), optional for prod
 *   CONVEX_HTTP_URL             HTTP actions URL, optional for prod
 *   WORKOS_CLIENT_ID            the target environment's client id
 *   WORKOS_API_KEY              the target environment's API key
 *   ASK_MCPJAM_CANARY_EMAIL     the dedicated canary user
 *   ASK_MCPJAM_CANARY_PASSWORD  optional; selects the password grant
 *   ASK_MCPJAM_SMOKE_PROJECT_ID optional; else the user's first project
 *   WORKOS_API_BASE             optional; default https://api.workos.com
 *
 * Prod runs leave CONVEX_URL / CONVEX_HTTP_URL / WORKOS_CLIENT_ID unset on the
 * Inspector so it boots on the `.env.production` the package ships — exactly
 * what a user gets. The script still needs the client id and Convex URL for
 * its own calls, so it reads them from the installed package's env file when
 * they are not given.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const STARTUP_TIMEOUT_MS = 180_000;
const TURN_TIMEOUT_MS = 240_000;
const AGENT_MODEL = "openai/gpt-5.6-luna";
const PROMPT =
  "This is an automated health check. Reply with one short sentence and do not call any tools.";

const env = process.env;
const tmpRoot = mkdtempSync(path.join(tmpdir(), "ask-mcpjam-smoke-"));
let child;
let serverOutput = "";

try {
  await main();
  console.log("Ask MCPJam smoke passed.");
} catch (error) {
  console.error(`::error::Ask MCPJam smoke failed: ${error.message}`);
  if (serverOutput) {
    console.error("---- Inspector output (tail) ----");
    console.error(redact(stripAnsi(serverOutput).slice(-6000)));
  }
  process.exitCode = 1;
} finally {
  if (child) await terminate(child);
  rmSync(tmpRoot, { recursive: true, force: true });
}

async function main() {
  const email = required("ASK_MCPJAM_CANARY_EMAIL");
  const apiKey = required("WORKOS_API_KEY");

  const { command, args, packageDir } = install();
  const packaged = readPackagedEnv(packageDir);
  const clientId = env.WORKOS_CLIENT_ID || packaged.VITE_WORKOS_CLIENT_ID;
  const convexUrl = env.CONVEX_URL || packaged.CONVEX_URL;
  if (!clientId) throw new Error("No WorkOS client id for this target.");
  if (!convexUrl) throw new Error("No Convex URL for this target.");

  const port = String(41000 + Math.floor(Math.random() * 2000));
  const baseUrl = await start(command, [...args, "--port", port, "--no-open"]);
  console.log(`Inspector is up at ${baseUrl} with no service token.`);

  const accessToken = await mintSession({ email, apiKey, clientId });
  console.log("Minted a first-party session for the canary user.");

  const projectId =
    env.ASK_MCPJAM_SMOKE_PROJECT_ID ||
    (await firstProject(convexUrl, accessToken));
  await runTurn({ baseUrl, accessToken, projectId });
}

function required(name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Install the Inspector under test and return how to start it. */
function install() {
  const tarballs = (env.INSPECTOR_TARBALLS ?? "").split(/\s+/).filter(Boolean);
  const npmSpec = env.INSPECTOR_NPM_SPEC?.trim();
  if (tarballs.length === 0 && !npmSpec) {
    throw new Error("Set INSPECTOR_TARBALLS or INSPECTOR_NPM_SPEC.");
  }
  const installDir = path.join(tmpRoot, "install");
  mkdirSync(installDir, { recursive: true });
  run("npm", ["init", "-y"], { cwd: installDir, quiet: true });
  const installArgs = [
    "install",
    "--no-audit",
    "--no-fund",
    "--legacy-peer-deps",
    ...(tarballs.length > 0 ? tarballs : [npmSpec]),
  ];
  // A version published seconds ago can still 404 on some registry edges, so
  // the post-publish run retries before it calls the release broken.
  for (let attempt = 1; ; attempt++) {
    try {
      run("npm", installArgs, { cwd: installDir });
      break;
    } catch (error) {
      if (tarballs.length > 0 || attempt >= 6) throw error;
      console.log(`npm install failed (attempt ${attempt}); retrying in 30s.`);
      spawnSync("sleep", ["30"]);
    }
  }
  const packageDir = path.join(
    installDir,
    "node_modules",
    "@mcpjam",
    "inspector"
  );
  const bin = path.join(packageDir, "bin", "start.js");
  if (!existsSync(bin)) throw new Error(`Installed package has no ${bin}.`);
  return { command: process.execPath, args: [bin], packageDir };
}

function readPackagedEnv(packageDir) {
  const values = {};
  for (const file of [".env.production", ".env"]) {
    const full = path.join(packageDir, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match && values[match[1]] === undefined) {
        values[match[1]] = match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
  return values;
}

/**
 * Start the Inspector the way a user does, minus the service token, and wait
 * for the local access link it prints once it is serving. Its origin is where
 * the turn goes; `/api/web/*` authenticates on the user's bearer, not on the
 * link's local token.
 */
function start(command, args) {
  const childEnv = { ...env };
  // The point of the test. Belt and braces: delete it even if the runner
  // never set it, so a future workflow change cannot quietly hand it over.
  delete childEnv.INSPECTOR_SERVICE_TOKEN;
  for (const secret of [
    "WORKOS_API_KEY",
    "ASK_MCPJAM_CANARY_PASSWORD",
    "SLACK_WEBHOOK_URL",
  ]) {
    delete childEnv[secret];
  }
  Object.assign(childEnv, {
    NODE_ENV: "production",
    VITE_MCPJAM_HOSTED_MODE: "false",
    MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
    MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK: "1",
    NO_COLOR: "1",
    // Never report the canary's own failures as a user's.
    DO_NOT_TRACK: "1",
  });
  if (env.CONVEX_URL) childEnv.VITE_CONVEX_URL = env.CONVEX_URL;

  child = spawn(command, args, {
    cwd: tmpRoot,
    env: childEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the Inspector printed no access link in time")),
      STARTUP_TIMEOUT_MS
    );
    const onData = (chunk) => {
      serverOutput += chunk.toString();
      const text = stripAnsi(serverOutput);
      const match = /(https?:\/\/[^\s#]+)\/?#token=[A-Za-z0-9._~-]+/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(new URL(match[1]).origin);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `the Inspector exited before it was ready (${code ?? signal})`
        )
      );
    });
  });
}

/** A first-party AuthKit session, minted for the canary user. */
async function mintSession({ email, apiKey, clientId }) {
  const base = (env.WORKOS_API_BASE || "https://api.workos.com").replace(
    /\/+$/,
    ""
  );
  const password = env.ASK_MCPJAM_CANARY_PASSWORD?.trim();
  let grant;
  if (password) {
    grant = { grant_type: "password", email, password };
  } else {
    // Magic Auth: creating a code through the API returns it, so no inbox is
    // involved. The code is single-use and short-lived.
    const created = await workos(`${base}/user_management/magic_auth`, apiKey, {
      email,
    });
    if (typeof created.code !== "string") {
      throw new Error("WorkOS created no Magic Auth code for the canary user.");
    }
    grant = {
      grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
      code: created.code,
      email,
    };
  }
  const session = await workos(`${base}/user_management/authenticate`, apiKey, {
    client_id: clientId,
    client_secret: apiKey,
    ...grant,
  });
  if (typeof session.access_token !== "string") {
    throw new Error("WorkOS returned no access token for the canary user.");
  }
  return session.access_token;
}

async function workos(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `WorkOS ${new URL(url).pathname} answered ${res.status}: ${redact(
        text.slice(0, 300)
      )}`
    );
  }
  return JSON.parse(text);
}

/** The canary user's first project, through the Convex client API. */
async function firstProject(convexUrl, accessToken) {
  const call = async (kind, functionPath) => {
    const res = await fetch(`${convexUrl.replace(/\/+$/, "")}/api/${kind}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: functionPath, args: {}, format: "json" }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.status !== "success") {
      throw new Error(
        `Convex ${functionPath} failed (${res.status}): ${redact(
          JSON.stringify(json).slice(0, 300)
        )}`
      );
    }
    return json.value;
  };
  await call("mutation", "users:ensureUser");
  const projects = await call("query", "projects:getMyProjects");
  const id = Array.isArray(projects) ? projects[0]?._id : undefined;
  if (typeof id !== "string") {
    throw new Error(
      "The canary user has no project. Sign in as them once, or set ASK_MCPJAM_SMOKE_PROJECT_ID."
    );
  }
  return id;
}

/** One Ask MCPJam turn, read to the end of its stream. */
async function runTurn({ baseUrl, accessToken, projectId }) {
  const res = await fetch(`${baseUrl}/api/web/mcpjam-agent`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messages: [
        {
          id: "smoke-user-1",
          role: "user",
          parts: [{ type: "text", text: PROMPT }],
        },
      ],
      // Ignored by the route, which pins the agent model; required by its
      // schema.
      model: { id: AGENT_MODEL },
      chatSessionId: `ask-mcpjam-smoke-${Date.now()}`,
      projectId,
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `/api/web/mcpjam-agent answered ${res.status}: ${redact(
        body.slice(0, 600)
      )}`
    );
  }

  const chunks = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const piece of res.body) {
    buffer += decoder.decode(piece, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        chunks.push(JSON.parse(data));
      } catch {
        throw new Error(`malformed stream chunk: ${data.slice(0, 200)}`);
      }
    }
  }

  const types = chunks.map((chunk) => chunk?.type);
  const errors = chunks.filter((chunk) => chunk?.type === "error");
  if (errors.length > 0) {
    throw new Error(
      `the turn streamed an error: ${redact(
        String(errors[0].errorText ?? JSON.stringify(errors[0])).slice(0, 600)
      )}`
    );
  }
  const text = chunks
    .filter((chunk) => chunk?.type === "text-delta")
    .map((chunk) => chunk.delta ?? chunk.textDelta ?? "")
    .join("");
  if (!text.trim()) {
    throw new Error(
      `the turn streamed no text (chunk types: ${summarize(types)})`
    );
  }
  if (!types.includes("finish")) {
    throw new Error(
      `the turn never finished (chunk types: ${summarize(types)})`
    );
  }
  console.log(`Turn streamed ${text.length} characters of text and finished.`);
}

function summarize(types) {
  const counts = new Map();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts].map(([type, n]) => `${type}×${n}`).join(", ") || "none";
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Never print a bearer, an access link's token, or a WorkOS key. */
function redact(text) {
  return String(text)
    .replace(/#token=[A-Za-z0-9._~-]+/g, "#token=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "<jwt>")
    .replace(/\bsk_[A-Za-z0-9_]{8,}/g, "<sk>");
}

function run(command, args, { cwd = tmpRoot, quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: quiet ? "ignore" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.status}.`);
  }
}

async function terminate(proc) {
  const signal = (sig) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid)
        process.kill(-proc.pid, sig);
      else proc.kill(sig);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const exited = () =>
    new Promise((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once("exit", resolve);
    });
  signal("SIGTERM");
  await Promise.race([exited(), new Promise((r) => setTimeout(r, 5000))]);
  signal("SIGKILL");
  proc.stdout?.destroy();
  proc.stderr?.destroy();
}
