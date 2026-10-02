import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SetupError,
  createIsolatedConvex,
  isolatedConvexEnv,
  parseDevelopmentSelector,
  setupGuestAuth,
} from "../dev-setup-guest-auth.mjs";
import { parseEnvText } from "../../bin/runtime-profile.mjs";

/** A fake deployment env store standing in for the isolated Convex CLI. */
function fakeConvex(initial = {}) {
  const store = { ...initial };
  const sets = [];
  const updates = [];
  return {
    store,
    sets,
    updates,
    async list() {
      return Object.keys(store);
    },
    async get(name) {
      return store[name] ?? null;
    },
    async setAll(entries) {
      updates.push(entries.map(([name]) => name));
      for (const [name, value] of entries) {
        sets.push(name);
        store[name] = value;
      }
    },
  };
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-setup-test-"));
  return {
    dir,
    file: join(dir, ".env.development.local"),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("only fully qualified development selectors are accepted", () => {
  assert.equal(
    parseDevelopmentSelector("dev:happy-otter-123"),
    "happy-otter-123",
  );
  for (const bad of [
    "dev",
    "happy-otter-123",
    "prod:happy-otter-123",
    "preview:my-branch",
    "dev:",
    "dev/james",
    "team:project:dev",
    "https://happy-otter-123.convex.cloud",
    "dev:Happy-Otter-123",
    undefined,
  ]) {
    assert.throws(() => parseDevelopmentSelector(bad), SetupError, String(bad));
  }
});

test("the Convex CLI gets no inherited deployment selection or credential", () => {
  const env = isolatedConvexEnv(
    {
      PATH: "/bin",
      HOME: "/home/x",
      CONVEX_DEPLOY_KEY: "prod:secret",
      CONVEX_DEPLOYMENT: "dev:someone-else-1",
      CONVEX_URL: "https://someone-else-1.convex.cloud",
      CONVEX_SELF_HOSTED_ADMIN_KEY: "k",
    },
    "dev:happy-otter-123",
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/x",
    CONVEX_DEPLOYMENT: "dev:happy-otter-123",
  });
});

test("initializes a fresh deployment and profile without writing GUEST_JWKS_URL", async () => {
  const { file, done } = scratch();
  try {
    const convex = fakeConvex();
    const result = await setupGuestAuth({
      selector: "dev:happy-otter-123",
      envFile: file,
      convex,
      now: Date.UTC(2026, 9, 2),
    });
    assert.equal(result.applied, true);
    assert.deepEqual(convex.sets.sort(), [
      "GUEST_JWT_KID",
      "GUEST_JWT_PRIVATE_KEY",
      "GUEST_JWT_PUBLIC_KEY",
      "GUEST_SESSION_HASH_PEPPER",
      "GUEST_SESSION_SHARED_SECRET",
    ]);
    // One update, so the deployment never holds half a key pair.
    assert.equal(convex.updates.length, 1);
    assert.equal(convex.store.GUEST_JWKS_URL, undefined);
    assert.match(convex.store.GUEST_JWT_PRIVATE_KEY, /BEGIN PRIVATE KEY/);

    const profile = parseEnvText(readFileSync(file, "utf8"));
    assert.equal(
      profile.CONVEX_HTTP_URL,
      "https://happy-otter-123.convex.site",
    );
    assert.equal(
      profile.VITE_CONVEX_URL,
      "https://happy-otter-123.convex.cloud",
    );
    assert.equal(profile.MCPJAM_GUEST_AUTHORITY, "backend");
    assert.equal(
      profile.MCPJAM_GUEST_SESSION_SHARED_SECRET,
      convex.store.GUEST_SESSION_SHARED_SECRET,
    );
    assert.equal(
      profile.GUEST_SESSION_HASH_PEPPER,
      convex.store.GUEST_SESSION_HASH_PEPPER,
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    done();
  }
});

test("never overwrites existing deployment values; reuses them for the profile", async () => {
  const { file, done } = scratch();
  try {
    const convex = fakeConvex({
      GUEST_JWT_PRIVATE_KEY: "existing-private",
      GUEST_JWT_PUBLIC_KEY: "existing-public",
      GUEST_SESSION_SHARED_SECRET: "existing-secret",
      GUEST_SESSION_HASH_PEPPER: "existing-pepper",
      GUEST_JWKS_URL: "https://happy-otter-123.convex.site/guest/jwks",
    });
    await setupGuestAuth({
      selector: "dev:happy-otter-123",
      envFile: file,
      convex,
    });
    assert.deepEqual(convex.sets, []);
    assert.equal(convex.store.GUEST_JWT_PRIVATE_KEY, "existing-private");
    const profile = parseEnvText(readFileSync(file, "utf8"));
    assert.equal(profile.MCPJAM_GUEST_SESSION_SHARED_SECRET, "existing-secret");
    assert.equal(profile.GUEST_SESSION_HASH_PEPPER, "existing-pepper");
  } finally {
    done();
  }
});

test("refuses a deployment paired with a foreign JWKS, before writing anything", async () => {
  const { file, done } = scratch();
  try {
    const convex = fakeConvex({
      GUEST_JWKS_URL: "https://app.mcpjam.com/api/web/guest-jwks",
    });
    await assert.rejects(
      setupGuestAuth({
        selector: "dev:energized-ant-201",
        envFile: file,
        convex,
      }),
      /operator-managed/,
    );
    assert.deepEqual(convex.sets, []);
    assert.throws(() => readFileSync(file, "utf8"));
  } finally {
    done();
  }
});

test("refuses a half-present key pair instead of repairing it", async () => {
  const { file, done } = scratch();
  try {
    const convex = fakeConvex({ GUEST_JWT_PUBLIC_KEY: "orphan" });
    await assert.rejects(
      setupGuestAuth({
        selector: "dev:happy-otter-123",
        envFile: file,
        convex,
      }),
      /one half/,
    );
    assert.deepEqual(convex.sets, []);
  } finally {
    done();
  }
});

test("refuses a profile that names another backend, and never overwrites a profile secret", async () => {
  const { file, done } = scratch();
  try {
    writeFileSync(file, "CONVEX_HTTP_URL=https://someone-else-9.convex.site\n");
    await assert.rejects(
      setupGuestAuth({
        selector: "dev:happy-otter-123",
        envFile: file,
        convex: fakeConvex(),
      }),
      /another backend/,
    );

    writeFileSync(
      file,
      "MCPJAM_GUEST_SESSION_SHARED_SECRET=from-elsewhere\nOPENAI_API_KEY=keep\n",
    );
    const convex = fakeConvex({
      GUEST_SESSION_SHARED_SECRET: "the-deployments",
    });
    await assert.rejects(
      setupGuestAuth({
        selector: "dev:happy-otter-123",
        envFile: file,
        convex,
      }),
      /does not match/,
    );
    assert.deepEqual(convex.sets, []);
    assert.match(readFileSync(file, "utf8"), /from-elsewhere/);
  } finally {
    done();
  }
});

test("a dry run writes nothing remote or local, and logs no secret", async () => {
  const { file, done } = scratch();
  try {
    const convex = fakeConvex({
      GUEST_SESSION_SHARED_SECRET: "super-secret-value",
    });
    const lines = [];
    const result = await setupGuestAuth({
      selector: "dev:happy-otter-123",
      envFile: file,
      convex,
      dryRun: true,
      log: (line) => lines.push(line),
    });
    assert.equal(result.applied, false);
    assert.deepEqual(convex.sets, []);
    assert.throws(() => readFileSync(file, "utf8"));
    assert.ok(!lines.join("\n").includes("super-secret-value"));
  } finally {
    done();
  }
});

test("refuses an unwritable profile before writing anything remote", async () => {
  const { dir, done } = scratch();
  try {
    const convex = fakeConvex();
    await assert.rejects(
      setupGuestAuth({
        selector: "dev:happy-otter-123",
        envFile: join(dir, "missing-dir", ".env.development.local"),
        convex,
      }),
      /cannot be written \(ENOENT\)/,
    );
    assert.deepEqual(convex.sets, []);
  } finally {
    done();
  }
});

/**
 * A stand-in for the Convex CLI that records its argv and stdin, then exits
 * with `exitCode` and nothing on stderr.
 */
function fakeCli(dir, exitCode) {
  const cli = join(dir, "fake-convex.cjs");
  const record = join(dir, "record.json");
  writeFileSync(
    cli,
    `let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(record)},
    JSON.stringify({ argv: process.argv.slice(2), input }));
  process.exit(${exitCode});
});
`,
  );
  return { cli, read: () => JSON.parse(readFileSync(record, "utf8")) };
}

test("secrets go to the Convex CLI on stdin, never in argv or a failure message", async () => {
  const { dir, done } = scratch();
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  }).privateKey.export({ type: "pkcs8", format: "pem" });
  const entries = [
    ["GUEST_JWT_PRIVATE_KEY", privateKey],
    ["GUEST_SESSION_SHARED_SECRET", "shared-secret-value"],
  ];
  const failing = fakeCli(dir, 1);
  const convex = createIsolatedConvex(
    "dev:happy-otter-123",
    process.env,
    failing.cli,
  );
  try {
    await assert.rejects(convex.setAll(entries), (error) => {
      assert.ok(error instanceof SetupError);
      assert.match(error.message, /GUEST_JWT_PRIVATE_KEY/);
      assert.match(error.message, /exit code 1/);
      assert.ok(!error.message.includes("PRIVATE KEY-----"));
      assert.ok(!error.message.includes("shared-secret-value"));
      return true;
    });
    const { argv, input } = failing.read();
    assert.deepEqual(argv, ["env", "set"]);
    // The CLI parses stdin with its own dotenv; the PEM must survive that.
    const dotenv = createRequire(
      createRequire(import.meta.url).resolve("convex/package.json"),
    )("dotenv");
    assert.deepEqual(dotenv.parse(input), Object.fromEntries(entries));
  } finally {
    convex.dispose();
    done();
  }
});
