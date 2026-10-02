#!/usr/bin/env node
/**
 * Initialize guest auth on YOUR OWN Convex development deployment, once, on
 * purpose.
 *
 *   npm run dev:setup-guest-auth -- --deployment dev:<name> [--env-file <profile>] [--dry-run]
 *
 * The Inspector used to do this on every start — and on guest requests,
 * document bootstrap and JWKS reads — writing whatever key pair and secrets
 * this machine had in `~/.mcpjam` into whichever deployment `.env.local`
 * named. Several worktrees and several developers took turns overwriting the
 * same shared deployment. Ordinary Inspector use now writes nothing remote;
 * this command is the one place that does, and it is careful about it:
 *
 *  - Only a fully qualified development selector (`dev:<deployment-name>`) is
 *    accepted. No `prod:`, no bare names, no `dev` shorthand, no URLs. The
 *    prefix is only a claim — Convex resolves the deployment by name — so
 *    before anything is read or written, the CLI is asked which deployment it
 *    acts on, and setup stops unless Convex reports that exact name as a
 *    development deployment.
 *  - The Convex CLI runs from an empty temporary directory with every
 *    inherited `CONVEX_*` setting (deploy keys included) removed, and is told
 *    the deployment explicitly. It cannot pick up a project's `.env.local` or
 *    a deploy key from the shell. `convex deployment select` is never used.
 *  - Missing values are initialized; existing ones are never overwritten. A
 *    half-present key pair is an error, not something to "repair".
 *  - `GUEST_JWKS_URL` is never written: a development backend verifies with
 *    its own `/guest/jwks` by default. A deployment already paired with some
 *    other authority is refused — that pairing is operator-managed.
 *  - The profile gets the deployment's addresses and its shared credentials,
 *    again only where missing, and is refused if it names another backend.
 *  - No secret value is ever printed.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatEnvAssignment,
  parseEnvText,
  resolveInvocationPath,
} from "../bin/runtime-profile.mjs";

const SELECTOR = /^dev:([a-z0-9]+(?:-[a-z0-9]+)*-\d+)$/;

export class SetupError extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupError";
  }
}

/** `dev:<name>` → `<name>`; anything else throws. */
export function parseDevelopmentSelector(raw) {
  const match = SELECTOR.exec(String(raw ?? "").trim());
  if (!match) {
    throw new SetupError(
      `"${raw ?? ""}" is not a fully qualified development selector. Pass ` +
        "--deployment dev:<deployment-name> (for example dev:happy-otter-123). " +
        "Production, preview, shorthand and URL selectors are refused.",
    );
  }
  return match[1];
}

function originOrNull(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function deploymentAddresses(name) {
  return {
    cloudUrl: `https://${name}.convex.cloud`,
    siteUrl: `https://${name}.convex.site`,
    jwksUrl: `https://${name}.convex.site/guest/jwks`,
  };
}

/** The inherited environment minus every Convex selection or credential. */
export function isolatedConvexEnv(baseEnv, selector) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("CONVEX_")) continue;
    env[key] = value;
  }
  env.CONVEX_DEPLOYMENT = selector;
  return env;
}

function generateGuestKeyPair(now) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    kid: `guest-${now.toString(36)}`,
  };
}

/**
 * Plan and apply. `convex` is `{ resolveDeployment(): Promise<{name, type}>,
 * list(): Promise<string[]>, get(name): Promise<string|null>,
 * setAll(entries): Promise<void> }` bound to the one selected deployment;
 * `resolveDeployment` reports what Convex itself resolved, and `setAll`
 * applies every `[name, value]` in one update.
 */
export async function setupGuestAuth({
  selector,
  envFile,
  dryRun = false,
  convex,
  fs = { existsSync, readFileSync, writeFileSync, chmodSync, accessSync },
  now = Date.now(),
  log = () => {},
}) {
  const name = parseDevelopmentSelector(selector);
  const addresses = deploymentAddresses(name);

  // ── the deployment Convex actually resolves, before any read or write ───
  const target = await convex.resolveDeployment();
  if (target.name !== name || target.type !== "dev") {
    throw new SetupError(
      `${selector} resolves to the ${target.type} deployment ${target.name}, not ` +
        `the development deployment ${name}. Nothing was read or written.`,
    );
  }

  // ── read the deployment; decide everything before writing anything ──────
  const present = new Set(await convex.list());
  if (present.has("GUEST_JWKS_URL")) {
    const configured = (await convex.get("GUEST_JWKS_URL"))?.trim() ?? "";
    if (configured && configured !== addresses.jwksUrl) {
      let origin = "another origin";
      try {
        origin = new URL(configured).origin;
      } catch {
        // keep the generic wording
      }
      throw new SetupError(
        `${selector} verifies guest tokens with ${origin}, not its own /guest/jwks. ` +
          "That pairing is operator-managed; this command will not change it. Use " +
          "your own development deployment.",
      );
    }
  }

  const hasPrivate = present.has("GUEST_JWT_PRIVATE_KEY");
  const hasPublic = present.has("GUEST_JWT_PUBLIC_KEY");
  if (hasPrivate !== hasPublic) {
    throw new SetupError(
      `${selector} has only one half of the guest signing key pair. Rotate it ` +
        "through the operator key-rotation workflow; this command never repairs keys.",
    );
  }

  const remoteWrites = [];
  if (!hasPrivate) {
    const pair = generateGuestKeyPair(now);
    remoteWrites.push(["GUEST_JWT_PRIVATE_KEY", pair.privateKey]);
    remoteWrites.push(["GUEST_JWT_PUBLIC_KEY", pair.publicKey]);
    if (!present.has("GUEST_JWT_KID"))
      remoteWrites.push(["GUEST_JWT_KID", pair.kid]);
  }

  const shared = {};
  for (const variable of [
    "GUEST_SESSION_SHARED_SECRET",
    "GUEST_SESSION_HASH_PEPPER",
  ]) {
    if (present.has(variable)) {
      const value = (await convex.get(variable))?.trim();
      if (!value) {
        throw new SetupError(
          `${selector} has an empty ${variable}; set it deliberately.`,
        );
      }
      shared[variable] = value;
    } else {
      shared[variable] = randomBytes(32).toString("hex");
      remoteWrites.push([variable, shared[variable]]);
    }
  }

  // ── the local profile ─────────────────────────────────────────────────
  const profilePath = resolve(envFile);
  const existingText = fs.existsSync(profilePath)
    ? fs.readFileSync(profilePath, "utf8")
    : "";
  const existing = parseEnvText(existingText);
  // Exact origins only: the deployment's credentials are about to join this
  // profile, and a lookalike host (`https://<name>.attacker.example`) kept
  // here would receive them on every guest request.
  const expectedOrigins = {
    CONVEX_HTTP_URL: addresses.siteUrl,
    CONVEX_URL: addresses.cloudUrl,
    VITE_CONVEX_URL: addresses.cloudUrl,
  };
  for (const [key, expected] of Object.entries(expectedOrigins)) {
    const value = existing[key];
    if (value && originOrNull(value) !== expected) {
      throw new SetupError(
        `${envFile} already points ${key} somewhere other than ${expected}. A ` +
          "profile names one backend; use a separate --env-file for this deployment.",
      );
    }
  }
  if (
    existing.MCPJAM_GUEST_AUTHORITY &&
    existing.MCPJAM_GUEST_AUTHORITY !== "backend"
  ) {
    throw new SetupError(
      `${envFile} selects the ${existing.MCPJAM_GUEST_AUTHORITY} guest authority; not changing it.`,
    );
  }
  const desiredLocal = {
    CONVEX_URL: addresses.cloudUrl,
    VITE_CONVEX_URL: addresses.cloudUrl,
    CONVEX_HTTP_URL: addresses.siteUrl,
    MCPJAM_GUEST_AUTHORITY: "backend",
    MCPJAM_GUEST_SESSION_SHARED_SECRET: shared.GUEST_SESSION_SHARED_SECRET,
    GUEST_SESSION_HASH_PEPPER: shared.GUEST_SESSION_HASH_PEPPER,
  };
  const localWrites = [];
  for (const [key, value] of Object.entries(desiredLocal)) {
    if (existing[key] === undefined || existing[key] === "") {
      localWrites.push([key, value]);
    } else if (
      (key === "MCPJAM_GUEST_SESSION_SHARED_SECRET" ||
        key === "GUEST_SESSION_HASH_PEPPER") &&
      existing[key] !== value
    ) {
      throw new SetupError(
        `${envFile} has a ${key} that does not match ${selector}'s. Not overwriting it; ` +
          "remove it from the profile if it belongs to nothing else.",
      );
    }
  }

  if (localWrites.length > 0) {
    // Refuse an unwritable profile before the deployment changes: once the
    // deployment has new secrets, a later run cannot regenerate them to match.
    const target = fs.existsSync(profilePath)
      ? profilePath
      : dirname(profilePath);
    try {
      fs.accessSync(target, constants.W_OK);
    } catch (error) {
      throw new SetupError(`${envFile} cannot be written (${error.code}).`);
    }
  }

  const plan = {
    deployment: selector,
    remote: remoteWrites.map(([key]) => key),
    local: localWrites.map(([key]) => key),
    profile: profilePath,
  };
  log(
    `Deployment ${selector}: ${plan.remote.length ? `initialize ${plan.remote.join(", ")}` : "already initialized"}`,
  );
  log(
    `Profile ${envFile}: ${plan.local.length ? `add ${plan.local.join(", ")}` : "already complete"}`,
  );
  if (dryRun) return { ...plan, applied: false };

  if (remoteWrites.length > 0) await convex.setAll(remoteWrites);
  if (localWrites.length > 0) {
    const prefix = existingText && !existingText.endsWith("\n") ? "\n" : "";
    const block = [
      "# Guest auth for your own development deployment (npm run dev:setup-guest-auth)",
      ...localWrites.map(([key, value]) => formatEnvAssignment(key, value)),
    ].join("\n");
    fs.writeFileSync(profilePath, `${existingText}${prefix}${block}\n`, "utf8");
    try {
      fs.chmodSync(profilePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  }
  return { ...plan, applied: true };
}

// ── the real Convex CLI, isolated ──────────────────────────────────────────

function convexCliPath() {
  const require = createRequire(import.meta.url);
  return join(
    dirname(require.resolve("convex/package.json")),
    "bin",
    "main.js",
  );
}

// Anchored to the line end so a chunk split mid-line never yields a partial type.
const RESOLVED_TARGET =
  /Deployment Name: ([^,\s]+), Deployment Type: ([a-z]+)\r?\n/g;

export function createIsolatedConvex(
  selector,
  baseEnv = process.env,
  cli = convexCliPath(),
  overrides = {},
) {
  const workdir = mkdtempSync(join(tmpdir(), "mcpjam-guest-auth-setup-"));
  // The CLI insists on a package.json that depends on convex; nothing else
  // lives here, so there is no .env.local or convex.json for it to find.
  writeFileSync(
    join(workdir, "package.json"),
    JSON.stringify({
      name: "mcpjam-guest-auth-setup",
      private: true,
      dependencies: { convex: "*" },
    }),
  );
  // `overrides` are explicit settings (tests point the CLI at a stand-in API);
  // nothing inherited survives isolation.
  const env = { ...isolatedConvexEnv(baseEnv, selector), ...overrides };
  env.CONVEX_DEPLOYMENT = selector;
  const run = (args, { label = args.join(" "), input = "" } = {}) =>
    new Promise((resolvePromise, reject) => {
      const child = execFile(
        process.execPath,
        [cli, ...args],
        {
          cwd: workdir,
          env,
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) return resolvePromise({ stdout, stderr });
          // Never error.message: it repeats the command line. stderr can name
          // the deployment but never carries a value we sent.
          const detail =
            stderr?.trim() ||
            (error.signal
              ? `signal ${error.signal}`
              : `exit code ${error.code}`);
          reject(new SetupError(`convex ${label} failed: ${detail}`));
        },
      );
      // A CLI that fails before reading its input closes the pipe; the exit
      // callback above reports that failure.
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") {
          reject(new SetupError(`convex ${label} failed: ${error.code}`));
        }
      });
      child.stdin.end(input);
    });
  return {
    workdir,
    /**
     * A read-only `env get` under CONVEX_VERBOSE: while loading credentials
     * the CLI logs the name and type from Convex's own authorization
     * response, whatever the selector claimed. The call is stopped as soon as
     * that line appears; no line means no confirmation, which is a refusal.
     */
    resolveDeployment() {
      return new Promise((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          [cli, "env", "get", "GUEST_JWT_KID"],
          {
            cwd: workdir,
            env: { ...env, CONVEX_VERBOSE: "1" },
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
          },
        );
        let stderr = "";
        let settled = false;
        const finish = (outcome) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (child.exitCode === null) child.kill();
          outcome();
        };
        const timer = setTimeout(
          () =>
            finish(() =>
              reject(
                new SetupError(
                  "Timed out confirming which deployment the Convex CLI acts on.",
                ),
              ),
            ),
          60_000,
        );
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
          const match = [...stderr.matchAll(RESOLVED_TARGET)].at(-1);
          if (match) {
            finish(() => resolvePromise({ name: match[1], type: match[2] }));
          }
        });
        child.once("error", (error) =>
          finish(() =>
            reject(new SetupError(`convex env get failed: ${error.code}`)),
          ),
        );
        child.once("close", () =>
          finish(() => {
            const detail = stderr
              .split(/\r?\n/)
              .filter((line) => line && !line.startsWith("[verbose]"))
              .join("\n")
              .trim();
            reject(
              new SetupError(
                "Could not confirm which deployment the Convex CLI acts on; " +
                  `nothing was read or written.${detail ? `\n${detail}` : ""}`,
              ),
            );
          }),
        );
      });
    },
    async list() {
      const { stdout } = await run(["env", "list", "--names-only"]);
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[A-Z_][A-Z0-9_]*$/.test(line));
    },
    async get(name) {
      const { stdout } = await run(["env", "get", name]);
      const value = stdout.replace(/\r?\n$/, "");
      return value === "" ? null : value;
    },
    /**
     * `env set` with no name reads a dotenv document from stdin and applies it
     * in one update, refusing all of it if any variable already differs. The
     * values stay out of argv, so out of the process list and error messages.
     */
    async setAll(entries) {
      await run(["env", "set"], {
        label: `env set ${entries.map(([name]) => name).join(", ")}`,
        input: `${entries
          .map(([name, value]) => formatEnvAssignment(name, value))
          .join("\n")}\n`,
      });
    },
    dispose() {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment") out.selector = argv[++i];
    else if (arg.startsWith("--deployment="))
      out.selector = arg.slice("--deployment=".length);
    else if (arg === "--env-file") out.envFile = argv[++i];
    else if (arg.startsWith("--env-file="))
      out.envFile = arg.slice("--env-file=".length);
    else if (arg === "--dry-run") out.dryRun = true;
    else throw new SetupError(`Unknown argument: ${arg}`);
  }
  if ("envFile" in out && !out.envFile) {
    throw new SetupError("--env-file needs a path.");
  }
  return out;
}

async function main() {
  const inspectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let convex;
  try {
    const args = parseArgs(process.argv.slice(2));
    const selector = args.selector;
    parseDevelopmentSelector(selector);
    const envFile = args.envFile
      ? resolveInvocationPath(args.envFile)
      : join(inspectorDir, ".env.development.local");
    convex = createIsolatedConvex(selector);
    const result = await setupGuestAuth({
      selector,
      envFile,
      dryRun: args.dryRun,
      convex,
      log: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      result.applied
        ? `Done. Launch with: npm run dev:worktree -- <instance> --env-file ${envFile}\n`
        : "Dry run: nothing was written.\n",
    );
  } catch (error) {
    process.stderr.write(
      `dev:setup-guest-auth: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    convex?.dispose();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
