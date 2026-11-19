import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
} from "../lib/qa-session.mjs";

function scratch(files) {
  const dir = mkdtempSync(join(tmpdir(), "qa-session-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const ENVIRONMENT = {
  name: "fix-refresh",
  profile: "/envs/fix-refresh/inspector.env",
  workspace: {
    projectId: "p1",
    serverName: "stateless",
    serverUrl: "https://stateless.mcpjam.com/mcp",
    path: "/p/p1/servers",
  },
};

test("parseQaArgs reads values and the --headed and --local switches", () => {
  assert.deepEqual(parseQaArgs(["--grant", "g.json", "--headed", "--local"]), {
    grant: "g.json",
    headed: true,
    local: true,
  });
  assert.throws(() => parseQaArgs(["--grant"]), /--grant needs a value/);
  assert.throws(() => parseQaArgs(["stray"]), /Unexpected argument: stray/);
});

test("resolveQaInputs takes the profile, workspace and server from environment.json", () => {
  const dir = scratch({ "environment.json": JSON.stringify(ENVIRONMENT) });
  try {
    const inputs = resolveQaInputs(
      { environment: "environment.json", grant: "grant.json" },
      dir,
    );
    assert.deepEqual(inputs, {
      name: "fix-refresh",
      profile: "/envs/fix-refresh/inspector.env",
      bundle: null,
      grant: null,
      grantPath: join(dir, "grant.json"),
      open: "/p/p1/servers",
      expectServer: "stateless",
      headed: false,
      local: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveQaInputs lets flags override the environment, and works without one", () => {
  const dir = scratch({ "environment.json": JSON.stringify(ENVIRONMENT) });
  try {
    const overridden = resolveQaInputs(
      {
        environment: "environment.json",
        grant: "g.json",
        open: "/p/p1/tools",
        "expect-server": "other",
        name: "second",
      },
      dir,
    );
    assert.equal(overridden.open, "/p/p1/tools");
    assert.equal(overridden.expectServer, "other");
    assert.equal(overridden.name, "second");

    const bare = resolveQaInputs({ profile: "p.env", grant: "g.json" }, dir);
    assert.equal(bare.profile, join(dir, "p.env"));
    assert.equal(bare.open, "/");
    assert.equal(bare.expectServer, null);
    assert.equal(bare.name, "default");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveQaInputs names what's missing", () => {
  assert.throws(
    () => resolveQaInputs({ profile: "p.env" }),
    /Pass --bundle <file>, or --grant <file>/,
  );
  assert.throws(
    () => resolveQaInputs({ profile: "p.env", grant: "g", name: "Bad Name" }),
    /--name must be a lowercase slug/,
  );
  assert.throws(
    () =>
      resolveQaInputs({ environment: "/nope/environment.json", grant: "g" }),
    /Can't read the environment summary/,
  );
});

test("requireProfile only needs a profile to start a new instance", () => {
  const inputs = resolveQaInputs({ grant: "g.json", name: "fix-refresh" });
  assert.equal(inputs.profile, null);
  assert.throws(
    () => requireProfile(inputs, false),
    /No QA session "fix-refresh" is running. Pass --bundle/,
  );
  assert.doesNotThrow(() => requireProfile(inputs, true));
  assert.equal(inputs.local, false);
});

test("localProfile turns hosted mode off and keeps everything else", () => {
  assert.equal(
    localProfile("A=1\nVITE_MCPJAM_HOSTED_MODE=true\n\nB=2\n"),
    "A=1\nB=2\nVITE_MCPJAM_HOSTED_MODE=false\n",
  );
});

test("checkMode refuses local mode on a hosted instance, and nothing else", () => {
  const local = { name: "fix-refresh", local: true };
  assert.throws(
    () => checkMode({ pid: 1 }, local),
    /"fix-refresh" is running in hosted mode. Stop it .*--name fix-refresh/,
  );
  assert.doesNotThrow(() => checkMode({ pid: 1, accessToken: "t" }, local));
  // Signing in another context follows whatever mode is running.
  assert.doesNotThrow(() =>
    checkMode({ pid: 1, accessToken: "t" }, { name: "fix-refresh" }),
  );
  assert.doesNotThrow(() => checkMode(null, local));
});

const BUNDLE = {
  kind: "mcpjam-agent-environment",
  version: 1,
  environment: {
    name: "qa-pr-7846",
    deployment: "happy-otter-123",
    backend: { ref: "main", commit: "a".repeat(40) },
    workspace: { serverName: "stateless", path: "/p/p1/servers" },
  },
  profile:
    "VITE_CONVEX_URL=https://happy-otter-123.convex.cloud\nINSPECTOR_SERVICE_TOKEN=s\n",
  flags: { skills: true },
  grant: {
    email: "agent@example.net",
    clientId: "client_1",
    refreshToken: "r",
  },
};

test("resolveQaInputs takes everything from a bundle", () => {
  const dir = scratch({
    "bundle.json": JSON.stringify(BUNDLE),
    "other.json": JSON.stringify({ ...BUNDLE, kind: "something-else" }),
    "bad-grant.json": JSON.stringify({ ...BUNDLE, grant: { email: "a" } }),
  });
  try {
    const inputs = resolveQaInputs({ bundle: "bundle.json" }, dir);
    assert.deepEqual(inputs, {
      name: "qa-pr-7846",
      profile: null,
      bundle: { profile: BUNDLE.profile, flags: { skills: true } },
      grant: BUNDLE.grant,
      grantPath: null,
      open: "/p/p1/servers",
      expectServer: "stateless",
      headed: false,
      local: false,
    });
    const withGrant = resolveQaInputs(
      { bundle: "bundle.json", grant: "g.json" },
      dir,
    );
    assert.equal(withGrant.grant, null);
    assert.equal(withGrant.grantPath, join(dir, "g.json"));
    assert.throws(
      () => resolveQaInputs({ bundle: "other.json" }, dir),
      /isn't an agent environment bundle/,
    );
    assert.throws(
      () => resolveQaInputs({ bundle: "bad-grant.json" }, dir),
      /has no clientId/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profileWithFlags points the profile at the local flags file", () => {
  const text = profileWithFlags(
    "A=1\nMCPJAM_FEATURE_FLAGS_FILE=/elsewhere.json\n\nB=2\n",
    "/tmp/qa/flags.json",
  );
  assert.equal(
    text,
    "A=1\nB=2\nMCPJAM_FEATURE_FLAGS_FILE=/tmp/qa/flags.json\n",
  );
});

test("readGrant needs an email, a client id and a refresh token", () => {
  const dir = scratch({
    "good.json": JSON.stringify({
      email: "a@example.net",
      clientId: "client_1",
      refreshToken: "r",
    }),
    "partial.json": JSON.stringify({ email: "a@example.net", clientId: "c" }),
    "broken.json": "{",
  });
  try {
    assert.equal(readGrant(join(dir, "good.json")).email, "a@example.net");
    assert.throws(
      () => readGrant(join(dir, "partial.json")),
      /has no refreshToken/,
    );
    assert.throws(() => readGrant(join(dir, "broken.json")), /isn't JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseInstanceLine finds the launcher's ports", () => {
  const log =
    "\n🌲 Instance 1  client :5174  server :6275  target local (/x/inspector.env)\n";
  assert.deepEqual(parseInstanceLine(log), {
    instance: 1,
    client: "http://localhost:5174",
    server: "http://localhost:6275",
  });
  assert.equal(parseInstanceLine("starting…"), null);
});

test("isReady needs the user and, for a seeded workspace, the saved server", () => {
  const page = "Servers stateless Disconnected agent-x@example.net";
  assert.equal(
    isReady(page, { email: "agent-x@example.net", expectServer: "stateless" }),
    true,
  );
  assert.equal(
    isReady("Servers agent-x@example.net", {
      email: "agent-x@example.net",
      expectServer: "stateless",
    }),
    false,
  );
  assert.equal(
    isReady("Sign in stateless", {
      email: "agent-x@example.net",
      expectServer: "stateless",
    }),
    false,
  );
  assert.equal(
    isReady("Welcome agent-x@example.net", {
      email: "agent-x@example.net",
      expectServer: null,
    }),
    true,
  );
});

test("session files live under a per-name directory", () => {
  const dir = sessionDir("fix-refresh", "/tmp/root");
  assert.equal(dir, "/tmp/root/mcpjam-qa/fix-refresh");
  assert.deepEqual(sessionFiles(dir), {
    session: join(dir, "session.json"),
    log: join(dir, "inspector.log"),
    storageState: join(dir, "storage-state.json"),
    screenshot: join(dir, "ready.png"),
    profile: join(dir, "inspector.env"),
    flags: join(dir, "flags.json"),
  });
});

test("isAlive tells a running pid from a finished one", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});
