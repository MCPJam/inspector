/**
 * The pieces of `qa:start` and `qa:stop` that need no browser, so they can be
 * tested: argument parsing, the inputs an agent environment hands over, the
 * launcher's port line, the ready check, and where a QA session keeps its
 * files.
 *
 * Inputs come from the backend's agent environments (`agent-env up` writes
 * `environment.json` and `sign-in --grant` writes a grant), or from any tool
 * that hands over the same shapes.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SESSION_ROOT = "mcpjam-qa";

export function parseQaArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === "headed") {
      options.headed = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} needs a value.`);
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Can't read the ${what} at ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`The ${what} at ${path} isn't JSON: ${error.message}`);
  }
}

/**
 * What to start and where to land. `--environment` (an agent environment's
 * `environment.json`) supplies the profile, the workspace path and the server
 * to expect; explicit flags override it.
 */
export function resolveQaInputs(options, cwd = process.cwd()) {
  const environment = options.environment
    ? readJson(resolve(cwd, options.environment), "environment summary")
    : {};
  const profile = options.profile ?? environment.profile;
  if (!profile) {
    throw new Error(
      "Pass --environment <environment.json> or --profile <inspector profile>.",
    );
  }
  if (!options.grant) {
    throw new Error(
      "Pass --grant <file>, a sign-in grant from the agent environment.",
    );
  }
  const name = options.name ?? environment.name ?? "default";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`--name must be a lowercase slug, not "${name}".`);
  }
  return {
    name,
    profile: resolve(cwd, profile),
    grantPath: resolve(cwd, options.grant),
    open: options.open ?? environment.workspace?.path ?? "/",
    expectServer:
      options["expect-server"] ?? environment.workspace?.serverName ?? null,
    headed: options.headed === true,
  };
}

export function readGrant(path) {
  const grant = readJson(path, "sign-in grant");
  for (const field of ["email", "clientId", "refreshToken"]) {
    if (typeof grant[field] !== "string" || grant[field].length === 0) {
      throw new Error(`The sign-in grant at ${path} has no ${field}.`);
    }
  }
  return grant;
}

/** The launcher's "🌲 Instance N  client :X  server :Y" line, or null. */
export function parseInstanceLine(text) {
  const match = /Instance (\d+)\s+client :(\d+)\s+server :(\d+)/.exec(text);
  if (!match) return null;
  return {
    instance: Number(match[1]),
    client: `http://localhost:${match[2]}`,
    server: `http://localhost:${match[3]}`,
  };
}

/**
 * Signed in and on the intended screen: the user's email is on the page and,
 * for a seeded workspace, so is the saved server.
 */
export function isReady(pageText, { email, expectServer }) {
  if (!pageText.includes(email)) return false;
  return expectServer ? pageText.includes(expectServer) : true;
}

export function sessionDir(name, root = tmpdir()) {
  return join(root, SESSION_ROOT, name);
}

export function sessionFiles(dir) {
  return {
    session: join(dir, "session.json"),
    log: join(dir, "inspector.log"),
    storageState: join(dir, "storage-state.json"),
    screenshot: join(dir, "ready.png"),
  };
}

/** True while `pid` exists; a pid that is gone answers ESRCH. */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
