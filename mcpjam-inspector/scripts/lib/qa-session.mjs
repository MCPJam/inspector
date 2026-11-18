/**
 * The pieces of `qa:start` and `qa:stop` that need no browser, so they can be
 * tested: argument parsing, the inputs an agent environment hands over, the
 * launcher's port line, the ready check, and where a QA session keeps its
 * files.
 *
 * Inputs come from the backend's agent environments: either one bundle (the
 * agent-environments MCP server's `get_environment` returns it), or the CLI's
 * files (`agent-env up` writes `environment.json`, `sign-in --grant` writes a
 * grant).
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

const BUNDLE_KIND = "mcpjam-agent-environment";

/** A sign-in grant: the user's email and a single-use refresh token. */
export function validateGrant(grant, source) {
  for (const field of ["email", "clientId", "refreshToken"]) {
    if (typeof grant?.[field] !== "string" || grant[field].length === 0) {
      throw new Error(`The sign-in grant in ${source} has no ${field}.`);
    }
  }
  return grant;
}

export function readGrant(path) {
  return validateGrant(readJson(path, "sign-in grant"), path);
}

function readBundle(path) {
  const bundle = readJson(path, "environment bundle");
  if (bundle?.kind !== BUNDLE_KIND || bundle.version !== 1) {
    throw new Error(
      `${path} isn't an agent environment bundle (kind "${BUNDLE_KIND}", version 1).`,
    );
  }
  if (typeof bundle.profile !== "string" || !bundle.environment?.name) {
    throw new Error(`The bundle at ${path} has no profile or environment.`);
  }
  return bundle;
}

/**
 * What to start and where to land. `--bundle` supplies everything; otherwise
 * `--environment` (an agent environment's `environment.json`) supplies the
 * profile, the workspace path and the server to expect, with `--grant` for
 * the sign-in. Explicit flags override either. The profile may be missing
 * when an instance of this name is already running (see `requireProfile`).
 */
export function resolveQaInputs(options, cwd = process.cwd()) {
  const bundle = options.bundle
    ? readBundle(resolve(cwd, options.bundle))
    : null;
  const environment = bundle
    ? bundle.environment
    : options.environment
      ? readJson(resolve(cwd, options.environment), "environment summary")
      : {};
  const grant =
    options.grant || !bundle
      ? null
      : validateGrant(bundle.grant, `the bundle at ${options.bundle}`);
  if (!grant && !options.grant) {
    throw new Error(
      "Pass --bundle <file>, or --grant <file> with a sign-in grant from the agent environment.",
    );
  }
  const name = options.name ?? environment.name ?? "default";
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw new Error(`--name must be a lowercase slug, not "${name}".`);
  }
  const profile = options.profile ?? (bundle ? null : environment.profile);
  return {
    name,
    profile: profile ? resolve(cwd, profile) : null,
    bundle: bundle
      ? { profile: bundle.profile, flags: bundle.flags ?? {} }
      : null,
    grant,
    grantPath: options.grant ? resolve(cwd, options.grant) : null,
    open: options.open ?? environment.workspace?.path ?? "/",
    expectServer:
      options["expect-server"] ?? environment.workspace?.serverName ?? null,
    headed: options.headed === true,
  };
}

/** A new instance needs a profile; signing in to a running one doesn't. */
export function requireProfile(inputs, running) {
  if (running || inputs.profile) return;
  throw new Error(
    `No QA session "${inputs.name}" is running. Pass --bundle <file>, or --environment <environment.json> or --profile <inspector profile>.`,
  );
}

/**
 * The profile text a bundle carries, pointed at the flags file written next
 * to it. A bundle leaves the flags path out because only this machine knows it.
 */
export function profileWithFlags(profileText, flagsPath) {
  const lines = profileText
    .split("\n")
    .filter(
      (line) => line.trim() && !line.startsWith("MCPJAM_FEATURE_FLAGS_FILE="),
    );
  return [...lines, `MCPJAM_FEATURE_FLAGS_FILE=${flagsPath}`].join("\n") + "\n";
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
    profile: join(dir, "inspector.env"),
    flags: join(dir, "flags.json"),
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
