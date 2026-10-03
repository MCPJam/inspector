import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuntimeConfigError,
  buildChildEnv,
  computeInstanceEnv,
  computeInstancePorts,
  computeWorkerVars,
  describeProfile,
  formatEnvAssignment,
  parseEnvText,
  resolveInvocationPath,
  resolveRuntimeProfile,
} from "../../bin/runtime-profile.mjs";

const STANDARD = [
  "VITE_CONVEX_URL=https://energized-ant-201.convex.cloud",
  "CONVEX_URL=https://energized-ant-201.convex.cloud",
  "VITE_WORKOS_CLIENT_ID=client_01KTN2EWHHJCKRB8RSR307X4SG",
  "CONVEX_HTTP_URL=https://energized-ant-201.convex.site",
  "ENVIRONMENT=local",
].join("\n");

function worktree(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcpjam-profile-"));
  const dir = join(root, "mcpjam-inspector");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".env.local"), STANDARD);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return { dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("the standard OSS profile needs no developer secrets and uses the hosted guest authority", () => {
  const w = worktree();
  try {
    const profile = resolveRuntimeProfile({ inspectorDir: w.dir, env: {} });
    assert.equal(profile.standard, true);
    assert.equal(profile.values.MCPJAM_GUEST_AUTHORITY, "hosted");
    assert.equal(
      profile.values.WORKOS_CLIENT_ID,
      "client_01KTN2EWHHJCKRB8RSR307X4SG",
    );
    assert.equal(
      profile.values.CONVEX_HTTP_URL,
      "https://energized-ant-201.convex.site",
    );
  } finally {
    w.done();
  }
});

test("an overlay naming another backend does NOT inherit the standard profile's backend settings", () => {
  const w = worktree({
    ".env.development.local": [
      "CONVEX_HTTP_URL=https://happy-otter-123.convex.site",
      "VITE_CONVEX_URL=https://happy-otter-123.convex.cloud",
      "MCPJAM_GUEST_SESSION_SHARED_SECRET=dev-secret",
      "OPENAI_API_KEY=sk-x",
    ].join("\n"),
  });
  try {
    const profile = resolveRuntimeProfile({ inspectorDir: w.dir, env: {} });
    assert.equal(profile.standard, false);
    assert.equal(
      profile.values.CONVEX_HTTP_URL,
      "https://happy-otter-123.convex.site",
    );
    // CONVEX_URL is derived from the overlay's VITE_CONVEX_URL, not the
    // standard profile's energized-ant-201.
    assert.equal(
      profile.values.CONVEX_URL,
      "https://happy-otter-123.convex.cloud",
    );
    assert.equal(profile.values.MCPJAM_GUEST_AUTHORITY, "backend");
    // The auth group was not touched by the overlay: still the dev client.
    assert.equal(
      profile.values.WORKOS_CLIENT_ID,
      "client_01KTN2EWHHJCKRB8RSR307X4SG",
    );
    assert.equal(profile.values.OPENAI_API_KEY, "sk-x");
  } finally {
    w.done();
  }
});

test("a backend credential without its backend is an actionable error, not a silent mix", () => {
  const w = worktree({
    ".env.development.local": "INSPECTOR_SERVICE_TOKEN=svc\n",
  });
  try {
    assert.throws(
      () => resolveRuntimeProfile({ inspectorDir: w.dir, env: {} }),
      (error) =>
        error instanceof RuntimeConfigError &&
        /CONVEX_HTTP_URL is not set/.test(error.message) &&
        /worktree profile/.test(error.message) &&
        !error.message.includes("svc"),
    );
  } finally {
    w.done();
  }
});

test("a private backend without guest credentials is refused with the setup command named", () => {
  const w = worktree({
    ".env.development.local": [
      "CONVEX_HTTP_URL=https://happy-otter-123.convex.site",
      "VITE_CONVEX_URL=https://happy-otter-123.convex.cloud",
    ].join("\n"),
  });
  try {
    assert.throws(
      () => resolveRuntimeProfile({ inspectorDir: w.dir, env: {} }),
      /dev:setup-guest-auth/,
    );
  } finally {
    w.done();
  }
});

test("staging never inherits the standard profile, and uses the staging WorkOS client", () => {
  const w = worktree();
  try {
    const profile = resolveRuntimeProfile({
      inspectorDir: w.dir,
      target: "staging",
      env: {
        MCPJAM_STAGING_VITE_CONVEX_URL:
          "https://proper-clownfish-150.convex.cloud",
        MCPJAM_STAGING_CONVEX_HTTP_URL:
          "https://proper-clownfish-150.convex.site",
      },
    });
    assert.equal(profile.explicit, true);
    assert.equal(
      profile.values.WORKOS_CLIENT_ID,
      "client_01K4C1TVA6CMQ3G32F1P301A9G",
    );
    assert.equal(profile.values.MCPJAM_GUEST_AUTHORITY, "hosted");
    assert.equal(
      profile.values.MCPJAM_GUEST_AUTHORITY_ORIGIN,
      "https://staging.mcpjam.com",
    );
    assert.equal(profile.values.ENVIRONMENT, undefined);
    assert.ok(!JSON.stringify(profile.values).includes("energized-ant-201"));
  } finally {
    w.done();
  }
});

test("--env-file takes priority and is the whole profile", () => {
  const w = worktree({
    "mine.env": [
      "CONVEX_HTTP_URL=https://happy-otter-123.convex.site",
      "VITE_CONVEX_URL=https://happy-otter-123.convex.cloud",
      "WORKOS_CLIENT_ID=client_custom",
      "MCPJAM_GUEST_SESSION_SHARED_SECRET=s",
    ].join("\n"),
  });
  try {
    const profile = resolveRuntimeProfile({
      inspectorDir: w.dir,
      envFile: join(w.dir, "mine.env"),
      env: {},
    });
    assert.equal(profile.values.WORKOS_CLIENT_ID, "client_custom");
    assert.equal(
      profile.values.ENVIRONMENT,
      undefined,
      "nothing from .env.local",
    );
    assert.throws(
      () =>
        resolveRuntimeProfile({
          inspectorDir: w.dir,
          envFile: join(w.dir, "missing.env"),
          env: {},
        }),
      /does not exist/,
    );
  } finally {
    w.done();
  }
});

test("the main worktree profile is a fallback for the default target only, read in place", () => {
  const main = worktree({
    ".env.development.local": "OPENAI_API_KEY=from-main\n",
  });
  const other = worktree();
  try {
    const fallback = resolveRuntimeProfile({
      inspectorDir: other.dir,
      mainInspectorDir: main.dir,
      env: {},
    });
    assert.equal(fallback.values.OPENAI_API_KEY, "from-main");
    assert.ok(fallback.layers.some((l) => l.name.includes("main worktree")));
  } finally {
    main.done();
    other.done();
  }
});

test("mismatched Convex deployments and WorkOS ids are refused", () => {
  const w = worktree({
    "bad.env": [
      "CONVEX_HTTP_URL=https://happy-otter-123.convex.site",
      "VITE_CONVEX_URL=https://other-deploy-9.convex.cloud",
      "WORKOS_CLIENT_ID=a",
      "VITE_WORKOS_CLIENT_ID=b",
      "MCPJAM_GUEST_AUTHORITY=hosted",
    ].join("\n"),
  });
  try {
    assert.throws(
      () =>
        resolveRuntimeProfile({
          inspectorDir: w.dir,
          envFile: join(w.dir, "bad.env"),
          env: {},
        }),
      (error) =>
        /different deployments/.test(error.message) &&
        /disagree/.test(error.message),
    );
  } finally {
    w.done();
  }
});

test("a CONVEX_URL naming another deployment than the browser URL is refused, not kept", () => {
  const w = worktree({
    "split.env": [
      "VITE_CONVEX_URL=https://test-one-123.convex.cloud",
      "CONVEX_HTTP_URL=https://test-one-123.convex.site",
      "CONVEX_URL=https://test-two-456.convex.cloud",
      "MCPJAM_GUEST_AUTHORITY=hosted",
    ].join("\n"),
    "agree.env": [
      "VITE_CONVEX_URL=https://test-one-123.convex.cloud",
      "CONVEX_HTTP_URL=https://test-one-123.convex.site",
      "CONVEX_URL=https://test-one-123.convex.cloud/",
      "MCPJAM_GUEST_AUTHORITY=hosted",
    ].join("\n"),
  });
  try {
    assert.throws(
      () =>
        resolveRuntimeProfile({
          inspectorDir: w.dir,
          envFile: join(w.dir, "split.env"),
          env: {},
        }),
      /VITE_CONVEX_URL \(test-one-123\) and CONVEX_URL \(test-two-456\) name different deployments/,
    );
    const agreed = resolveRuntimeProfile({
      inspectorDir: w.dir,
      envFile: join(w.dir, "agree.env"),
      env: {},
    });
    assert.equal(
      agreed.values.CONVEX_URL,
      "https://test-one-123.convex.cloud/",
    );
  } finally {
    w.done();
  }
});

test("ports default to the documented offsets, honour overrides, and must be distinct", () => {
  assert.deepEqual(computeInstancePorts(3), {
    client: 5176,
    server: 6277,
    worker: 8790,
    debugger: 9232,
  });
  assert.deepEqual(computeInstancePorts(1, { server: "7000" }), {
    client: 5174,
    server: 7000,
    worker: 8788,
    debugger: 9230,
  });
  assert.throws(() => computeInstancePorts(1, { worker: "6275" }), /both 6275/);
  assert.throws(
    () => computeInstancePorts(1, { client: "70000" }),
    /between 1 and 65535/,
  );
  assert.throws(() => computeInstancePorts(-1), /non-negative/);
});

test("per-instance origins follow the ports; inherited loopback origins never survive a port change", () => {
  const ports = computeInstancePorts(2);
  const env = computeInstanceEnv({
    ports,
    browserPort: ports.client,
    profile: {
      CLI_AUTH_PUBLIC_ORIGIN: "http://localhost:5173",
      SLACK_LINK_PUBLIC_ORIGIN: "https://tunnel.example.dev/x",
      WEB_ALLOWED_ORIGINS: "http://localhost:5173,https://partner.example",
    },
    withWorker: true,
  });
  assert.equal(env.CLI_AUTH_PUBLIC_ORIGIN, "http://localhost:5175");
  assert.equal(env.DISCORD_LINK_PUBLIC_ORIGIN, "http://localhost:5175");
  assert.equal(env.SLACK_LINK_PUBLIC_ORIGIN, "https://tunnel.example.dev");
  assert.equal(env.MCPJAM_BROWSER_PORT, "5175");
  assert.equal(env.VITE_API_BASE_URL, "http://localhost:6276");
  assert.equal(env.MCPJAM_PLATFORM_MCP_URL, "http://localhost:8789/mcp");
  assert.equal(
    env.WEB_ALLOWED_ORIGINS,
    "http://localhost:5175,http://127.0.0.1:5175,http://[::1]:5175,https://partner.example",
  );
  const worker = computeWorkerVars({
    ports,
    profile: { WORKOS_CLIENT_ID: "client_01KTN2EWHHJCKRB8RSR307X4SG" },
  });
  assert.equal(worker.PLATFORM_API_URL, "http://localhost:6276/api/v1");
  assert.equal(
    worker.MCPJAM_GUEST_MINT_URL,
    "http://localhost:6276/api/web/guest-token",
  );
  assert.equal(worker.AUTHKIT_DOMAIN, "deep-vanilla-68-test.authkit.app");
});

test("children never inherit profile-owned values from the shell", () => {
  const { env, droppedInheritedKeys } = buildChildEnv({
    baseEnv: {
      PATH: "/bin",
      CONVEX_HTTP_URL: "https://shell-target.convex.site",
      INSPECTOR_SERVICE_TOKEN: "shell-token",
      COMPUTERS_TERMINAL_TOKEN_SECRET: "shell-secret",
      CLI_AUTH_PUBLIC_ORIGIN: "http://localhost:5173",
      DEPLOYMENT_SESSION_JWT_SECRET: "x",
    },
    profileValues: { CONVEX_HTTP_URL: "https://selected.convex.site" },
    instanceEnv: { CLI_AUTH_PUBLIC_ORIGIN: "http://localhost:5175" },
  });
  assert.equal(env.CONVEX_HTTP_URL, "https://selected.convex.site");
  assert.equal(env.INSPECTOR_SERVICE_TOKEN, undefined);
  assert.equal(env.COMPUTERS_TERMINAL_TOKEN_SECRET, undefined);
  assert.equal(env.DEPLOYMENT_SESSION_JWT_SECRET, undefined);
  assert.equal(env.CLI_AUTH_PUBLIC_ORIGIN, "http://localhost:5175");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.MCPJAM_RESOLVED_RUNTIME, "1");
  assert.deepEqual(droppedInheritedKeys, [
    "COMPUTERS_TERMINAL_TOKEN_SECRET",
    "DEPLOYMENT_SESSION_JWT_SECRET",
    "INSPECTOR_SERVICE_TOKEN",
  ]);
});

test("describing a profile never prints a secret", () => {
  const lines = describeProfile({
    values: {
      MCPJAM_GUEST_SESSION_SHARED_SECRET: "s3cret",
      INSPECTOR_SERVICE_TOKEN: "tok",
      WORKOS_API_KEY: "sk_live",
      CONVEX_HTTP_URL: "https://a.convex.site",
    },
  }).join("\n");
  assert.ok(!/s3cret|tok\b|sk_live/.test(lines));
  assert.match(lines, /CONVEX_HTTP_URL=https:\/\/a\.convex\.site/);
});

test("env files round-trip multi-line values", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n";
  const text = [
    formatEnvAssignment("KEY", pem),
    "PLAIN=1",
    "# c",
    "export Q='a b'",
  ].join("\n");
  assert.deepEqual(parseEnvText(text), { KEY: pem, PLAIN: "1", Q: "a b" });
});

test("env files round-trip quotes, backslashes and a literal backslash-n", () => {
  const values = {
    QUOTE: 'a"b',
    BACKSLASH: "C:\\path\\to",
    LITERAL_BACKSLASH_N: "not\\na newline",
    MIXED: 'x\\"y\n"z"\r\n',
  };
  const text = Object.entries(values)
    .map(([key, value]) => formatEnvAssignment(key, value))
    .join("\n");
  assert.deepEqual(parseEnvText(text), values);
});

test("a quoted value ends at its closing quote, not at the end of the line", () => {
  const text = [
    'CONVEX_HTTP_URL="https://x.convex.site" # mine',
    "WORKOS_CLIENT_ID=client_1",
    "SINGLE='it''s' # trailing",
    'MULTI="line one',
    'line two" # c',
    "AFTER=1",
  ].join("\n");
  assert.deepEqual(parseEnvText(text), {
    CONVEX_HTTP_URL: "https://x.convex.site",
    WORKOS_CLIENT_ID: "client_1",
    SINGLE: "it",
    MULTI: "line one\nline two",
    AFTER: "1",
  });
});

test("an unterminated quote is an error naming the key, not the rest of the file", () => {
  assert.throws(
    () => parseEnvText('A=1\nSECRET="abc\nB=2\n'),
    (error) =>
      error instanceof RuntimeConfigError &&
      /SECRET/.test(error.message) &&
      !error.message.includes("abc"),
  );
});

test("an unparseable public origin is dropped, not a startup failure", () => {
  const env = computeInstanceEnv({
    ports: { server: 6274 },
    browserPort: 6274,
    profile: { CLI_AUTH_PUBLIC_ORIGIN: "not a url" },
  });
  assert.equal(env.CLI_AUTH_PUBLIC_ORIGIN, "http://localhost:6274");
});

const PREVIEW_URLS = [
  "https://brave-fox-42.convex.cloud",
  "https://brave-fox-42.convex.site",
];

test("preview alone uses the staging WorkOS client and the hosted guest authority", () => {
  const w = worktree();
  try {
    const profile = resolveRuntimeProfile({
      inspectorDir: w.dir,
      target: "preview",
      previewUrls: PREVIEW_URLS,
      env: {},
    });
    assert.equal(profile.values.CONVEX_HTTP_URL, PREVIEW_URLS[1]);
    assert.equal(profile.values.VITE_CONVEX_URL, PREVIEW_URLS[0]);
    assert.equal(
      profile.values.WORKOS_CLIENT_ID,
      "client_01K4C1TVA6CMQ3G32F1P301A9G",
    );
    assert.equal(profile.values.MCPJAM_GUEST_AUTHORITY, "hosted");
    assert.equal(
      profile.values.MCPJAM_GUEST_AUTHORITY_ORIGIN,
      "https://staging.mcpjam.com",
    );
  } finally {
    w.done();
  }
});

test("preview with --env-file keeps the preview URLs and takes the file's guest credentials", () => {
  const w = worktree({
    "preview.env": [
      "MCPJAM_GUEST_AUTHORITY=backend",
      "MCPJAM_GUEST_SESSION_SHARED_SECRET=preview-secret",
      "OPENAI_API_KEY=sk-x",
    ].join("\n"),
    "other.env": [
      "CONVEX_HTTP_URL=https://someone-else-9.convex.site",
      "MCPJAM_GUEST_SESSION_SHARED_SECRET=other-secret",
    ].join("\n"),
  });
  try {
    const profile = resolveRuntimeProfile({
      inspectorDir: w.dir,
      target: "preview",
      previewUrls: PREVIEW_URLS,
      envFile: join(w.dir, "preview.env"),
      env: {},
    });
    assert.equal(profile.values.CONVEX_HTTP_URL, PREVIEW_URLS[1]);
    assert.equal(profile.values.CONVEX_URL, PREVIEW_URLS[0]);
    assert.equal(profile.values.MCPJAM_GUEST_AUTHORITY, "backend");
    assert.equal(
      profile.values.MCPJAM_GUEST_SESSION_SHARED_SECRET,
      "preview-secret",
    );
    assert.equal(profile.values.OPENAI_API_KEY, "sk-x");
    assert.equal(
      profile.values.WORKOS_CLIENT_ID,
      "client_01K4C1TVA6CMQ3G32F1P301A9G",
    );

    // A file that names another backend would pair its secret with the
    // preview deployment.
    assert.throws(
      () =>
        resolveRuntimeProfile({
          inspectorDir: w.dir,
          target: "preview",
          previewUrls: PREVIEW_URLS,
          envFile: join(w.dir, "other.env"),
          env: {},
        }),
      /different backend/,
    );
  } finally {
    w.done();
  }
});

test("a relative path is resolved from where npm was run, not the workspace", () => {
  assert.equal(
    resolveInvocationPath("mcpjam-inspector/.env.development.local", {
      INIT_CWD: join(tmpdir(), "repo"),
    }),
    join(tmpdir(), "repo", "mcpjam-inspector", ".env.development.local"),
  );
  assert.equal(
    resolveInvocationPath("x.env", {}),
    join(process.cwd(), "x.env"),
  );
});
