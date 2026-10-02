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
 *    accepted. No `prod:`, no bare names, no `dev` shorthand, no URLs.
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
import { execFile } from "node:child_process";
import {
  chmodSync,
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
import { formatEnvAssignment, parseEnvText } from "../bin/runtime-profile.mjs";

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
 * Plan and apply. `convex` is `{ list(): Promise<string[]>, get(name):
 * Promise<string|null>, set(name, value): Promise<void> }` bound to the one
 * selected deployment.
 */
export async function setupGuestAuth({
  selector,
  envFile,
  dryRun = false,
  convex,
  fs = { existsSync, readFileSync, writeFileSync, chmodSync },
  now = Date.now(),
  log = () => {},
}) {
  const name = parseDevelopmentSelector(selector);
  const addresses = deploymentAddresses(name);

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
  for (const key of ["CONVEX_HTTP_URL", "CONVEX_URL", "VITE_CONVEX_URL"]) {
    const value = existing[key];
    if (value && !value.includes(`://${name}.`)) {
      throw new SetupError(
        `${envFile} already points ${key} at another backend. A profile names ` +
          "one backend; use a separate --env-file for this deployment.",
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

  for (const [key, value] of remoteWrites) {
    await convex.set(key, value);
  }
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

export function createIsolatedConvex(selector, baseEnv = process.env) {
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
  const env = isolatedConvexEnv(baseEnv, selector);
  const cli = convexCliPath();
  const run = (args) =>
    new Promise((resolvePromise, reject) => {
      execFile(
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
          // stderr can name the deployment but never carries a value we sent.
          reject(
            new SetupError(
              `convex ${args[0]} ${args[1] ?? ""} failed: ${stderr?.trim() || error.message}`,
            ),
          );
        },
      );
    });
  return {
    workdir,
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
    async set(name, value) {
      await run(["env", "set", name, "--", value]);
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
  return out;
}

async function main() {
  const inspectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let convex;
  try {
    const args = parseArgs(process.argv.slice(2));
    const selector = args.selector;
    parseDevelopmentSelector(selector);
    const envFile =
      args.envFile ?? join(inspectorDir, ".env.development.local");
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
