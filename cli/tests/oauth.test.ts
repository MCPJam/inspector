import assert from "node:assert/strict";
import test from "node:test";
import { Command } from "commander";
import {
  buildOAuthConformanceConfig,
  registerOAuthCommands,
  buildOAuthLoginDebugOutcome,
  buildOAuthLoginConfig,
  buildOAuthLoginSnapshotConfig,
  summarizeOAuthLoginCommandInput,
  withDefaultOAuthConformanceChecks,
} from "../src/commands/oauth.js";
import { CliError } from "../src/lib/output.js";

test("buildOAuthConformanceConfig defaults to interactive auth", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
  });

  assert.equal(config.auth?.mode, "interactive");
  assert.equal(config.registrationStrategy, "cimd");
});

test("buildOAuthConformanceConfig can default login flows to interactive auth", () => {
  const config = buildOAuthConformanceConfig(
    {
      url: "https://example.com/mcp",
      protocolVersion: "2025-11-25",
      registration: "cimd",
    },
    {
      defaultAuthMode: "interactive",
    },
  );

  assert.equal(config.auth?.mode, "interactive");
});

test("buildOAuthConformanceConfig maps preregistered client settings", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "preregistered",
    authMode: "interactive",
    clientId: "client-id",
    clientSecret: "client-secret",
    header: ["X-Test: 1"],
  });

  assert.equal(config.auth?.mode, "interactive");
  assert.deepEqual(config.client?.preregistered, {
    clientId: "client-id",
    clientSecret: "client-secret",
  });
  assert.deepEqual(config.customHeaders, {
    "X-Test": "1",
  });
});

test("buildOAuthConformanceConfig maps redirectUrl when provided", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    redirectUrl: "https://app.example.com/oauth/callback",
  });

  assert.equal(config.redirectUrl, "https://app.example.com/oauth/callback");
});

test("buildOAuthConformanceConfig allows DCR client_credentials without explicit creds", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "dcr",
    authMode: "client_credentials",
  });

  if (config.auth?.mode !== "client_credentials") {
    assert.fail("Expected client_credentials auth mode");
  }

  assert.equal(config.auth.clientId, "__dynamic_registration_client__");
  assert.equal(config.auth.clientSecret, "__dynamic_registration_secret__");
});

test("buildOAuthConformanceConfig adds verification when --verify-tools is set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
    verifyTools: true,
  });

  assert.equal(config.verification?.listTools, true);
  assert.equal(config.verification?.callTool, undefined);
});

test("buildOAuthConformanceConfig adds callTool when --verify-call-tool is set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "dcr",
    verifyCallTool: "execute_sql",
  });

  assert.equal(config.verification?.listTools, true);
  assert.deepEqual(config.verification?.callTool, { name: "execute_sql" });
});

test("buildOAuthConformanceConfig omits verification when flags not set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "cimd",
  });

  assert.equal(config.verification, undefined);
});

test("buildOAuthConformanceConfig enables conformance checks when flag is set", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    conformanceChecks: true,
  });

  assert.equal(config.oauthConformanceChecks, true);
});

test("buildOAuthConformanceConfig passes advice ids through as readinessIds", () => {
  const base = {
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
  } as const;

  assert.equal("readinessIds" in buildOAuthConformanceConfig(base), false);
  assert.deepEqual(
    buildOAuthConformanceConfig({
      ...base,
      adviceId: ["readiness-oauth-iss-advertised"],
    }).readinessIds,
    ["readiness-oauth-iss-advertised"],
  );
});

test("buildOAuthConformanceConfig rejects unknown advice ids, and another suite's", () => {
  for (const adviceId of [["bogus"], ["readiness-log-level-filtering"], [""]]) {
    assert.throws(
      () =>
        buildOAuthConformanceConfig({
          url: "https://example.com/mcp",
          protocolVersion: "2025-11-25",
          registration: "dcr",
          adviceId,
        }),
      (error) =>
        error instanceof CliError && error.message.includes("advice id"),
    );
  }
});

test("oauth conformance threads --advice-id into readinessIds", async () => {
  const program = new Command();
  program.exitOverride();
  registerOAuthCommands(program);
  const conformance = program.commands
    .find((c) => c.name() === "oauth")
    ?.commands.find((c) => c.name() === "conformance");
  assert.ok(conformance, "oauth conformance should be registered");
  let captured: ReturnType<typeof buildOAuthConformanceConfig> | undefined;
  // Replace the network-running action so only option parsing is exercised.
  conformance.action((options) => {
    captured = buildOAuthConformanceConfig(options);
  });

  await program.parseAsync(
    [
      "oauth",
      "conformance",
      "--url",
      "https://example.com/mcp",
      "--protocol-version",
      "2025-11-25",
      "--registration",
      "dcr",
      "--advice-id",
      "readiness-oauth-iss-advertised",
    ],
    { from: "user" },
  );

  assert.deepEqual(captured?.readinessIds, ["readiness-oauth-iss-advertised"]);
});

test("buildOAuthConformanceConfig runs conformance checks by default", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
  });

  assert.equal(config.oauthConformanceChecks, true);
});

test("withDefaultOAuthConformanceChecks turns checks on unless the suite file turns them off", () => {
  const flows = [
    { protocolVersion: "2025-11-25" as const, registrationStrategy: "dcr" as const },
    {
      protocolVersion: "2025-11-25" as const,
      registrationStrategy: "cimd" as const,
      oauthConformanceChecks: false,
    },
  ];

  const unset = withDefaultOAuthConformanceChecks({
    serverUrl: "https://example.com/mcp",
    flows,
  });
  assert.equal(unset.defaults?.oauthConformanceChecks, true);
  // A flow's own value still wins over defaults when the SDK merges them.
  assert.equal(unset.flows[1].oauthConformanceChecks, false);

  const off = withDefaultOAuthConformanceChecks({
    serverUrl: "https://example.com/mcp",
    defaults: { oauthConformanceChecks: false },
    flows,
  });
  assert.equal(off.defaults?.oauthConformanceChecks, false);
});

test("buildOAuthLoginConfig defaults login flows to automatic protocol and registration planning", () => {
  const config = buildOAuthLoginConfig({
    url: "https://example.com/mcp",
    authMode: "interactive",
  });

  assert.equal(config.protocolMode, "auto");
  assert.equal(config.registrationMode, "auto");
  assert.equal(config.protocolVersion, undefined);
  assert.equal(config.registrationStrategy, undefined);
  assert.equal(config.auth?.mode, "interactive");
});

test("buildOAuthLoginDebugOutcome records credential file write failures", () => {
  const result = {
    completed: true,
  } as any;
  const error = new Error("credential path is not writable");

  const outcome = buildOAuthLoginDebugOutcome({
    result,
    credentialsFileError: error,
  });

  assert.equal(outcome.status, "error");
  if (outcome.status !== "error") {
    assert.fail("Expected error outcome");
  }
  assert.equal(outcome.result, result);
  assert.equal(outcome.error, error);
});

test("buildOAuthConformanceConfig sets openUrl for print-url in interactive mode", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    authMode: "interactive",
    printUrl: true,
  });

  assert.equal(config.auth?.mode, "interactive");
  assert.equal(typeof (config.auth as any).openUrl, "function");
});

test("buildOAuthConformanceConfig rejects print-url with headless mode", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "dcr",
        authMode: "headless",
        printUrl: true,
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--print-url only applies to --auth-mode interactive"),
  );
});

test("buildOAuthConformanceConfig rejects print-url with client_credentials mode", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "preregistered",
        authMode: "client_credentials",
        clientId: "id",
        clientSecret: "secret",
        printUrl: true,
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--print-url only applies to --auth-mode interactive"),
  );
});

test("buildOAuthConformanceConfig rejects unsupported combinations", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-06-18",
        registration: "cimd",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("CIMD registration is not supported"),
  );

  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "cimd",
        authMode: "client_credentials",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--auth-mode client_credentials cannot be used with --registration cimd") &&
      error.message.includes("only works with --auth-mode headless or --auth-mode interactive") &&
      error.message.includes("use --registration dcr or --registration preregistered"),
  );

  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-11-25",
        registration: "preregistered",
        authMode: "client_credentials",
        clientId: "client-id",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("--client-secret is required"),
  );
});

test("buildOAuthLoginSnapshotConfig pins the 2026-07-28 stateless wire era", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2026-07-28",
    registration: "cimd",
    authMode: "interactive",
  });

  const snapshotConfig = buildOAuthLoginSnapshotConfig(config, {
    completed: true,
    serverUrl: "https://example.com/mcp",
    protocolVersion: "2026-07-28",
    registrationStrategy: "cimd",
    protocolMode: "2026-07-28",
    registrationMode: "cimd",
    authMode: "interactive",
    redirectUrl: "https://app.example.com/callback",
    currentStep: "complete",
    credentials: { accessToken: "access-token", clientId: "client-id" },
    state: { currentStep: "complete", httpHistory: [], infoLogs: [] } as any,
  } as any);

  assert.equal("url" in snapshotConfig, true);
  assert.equal((snapshotConfig as any).mcpProtocolVersion, "2026-07-28");
});

test("buildOAuthLoginSnapshotConfig falls back to the requested 2026 protocol when the login throws before a result", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2026-07-28",
    registration: "cimd",
    authMode: "interactive",
  });

  // No result — mirrors `runOAuthLogin` throwing during 2026 discovery.
  const snapshotConfig = buildOAuthLoginSnapshotConfig(config, undefined);

  assert.equal((snapshotConfig as any).mcpProtocolVersion, "2026-07-28");
});

test("buildOAuthConformanceConfig accepts CIMD for the 2026-07-28 protocol", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2026-07-28",
    registration: "cimd",
  });

  assert.equal(config.registrationStrategy, "cimd");
  assert.equal(config.auth?.mode, "interactive");
});

test("buildOAuthConformanceConfig rejects an invalid redirectUrl", () => {
  assert.throws(
    () =>
      buildOAuthConformanceConfig({
        url: "https://example.com/mcp",
        protocolVersion: "2025-06-18",
        registration: "dcr",
        redirectUrl: "not-a-url",
      }),
    (error) =>
      error instanceof CliError &&
      error.message.includes("Invalid redirect URL"),
  );
});

test("summarizeOAuthLoginCommandInput captures header names and auth flags", () => {
  const summary = summarizeOAuthLoginCommandInput({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    authMode: "interactive",
    clientId: "client-id",
    clientSecret: "client-secret",
    header: ["Authorization: Bearer top-secret", "X-Test: 1"],
    verifyTools: true,
    verifyCallTool: "echo",
  });

  assert.equal(summary.serverUrl, "https://example.com/mcp");
  assert.equal(summary.protocolMode, "2025-11-25");
  assert.equal(summary.registrationMode, "dcr");
  assert.equal(summary.hasClientId, true);
  assert.equal(summary.hasClientSecret, true);
  assert.deepEqual(summary.headerNames, ["Authorization", "X-Test"]);
  assert.equal(summary.verifyTools, true);
  assert.equal(summary.verifyCallTool, "echo");
});

test("buildOAuthLoginSnapshotConfig prefers access tokens over refresh tokens", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registration: "dcr",
    authMode: "interactive",
    header: ["X-Test: 1"],
  });

  const snapshotConfig = buildOAuthLoginSnapshotConfig(config, {
    completed: true,
    serverUrl: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    protocolMode: "auto",
    registrationMode: "auto",
    authMode: "interactive",
    redirectUrl: "https://app.example.com/callback",
    currentStep: "complete",
    authorizationPlan: {
      protocolMode: "auto",
      protocolVersion: "2025-11-25",
      registrationMode: "auto",
      registrationStrategy: "dcr",
      status: "ready",
      blockerDetails: [],
      blockers: [],
      warnings: [],
      capabilities: {
        registrationStrategies: ["preregistered", "dcr"],
        supportsCimd: false,
        supportsDcr: true,
      },
      canonicalResource: "https://example.com/mcp",
      summary: "Automatic discovery resolved to Dynamic Client Registration (DCR).",
    },
    credentials: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      clientId: "client-id",
    },
    state: {
      currentStep: "complete",
      httpHistory: [],
      infoLogs: [],
    } as any,
  });

  assert.equal("url" in snapshotConfig, true);
  assert.equal(snapshotConfig.accessToken, "access-token");
  assert.equal(snapshotConfig.refreshToken, undefined);
  assert.deepEqual(snapshotConfig.requestInit?.headers, {
    "X-Test": "1",
  });
});

test("buildOAuthLoginSnapshotConfig falls back to refresh-token auth when needed", () => {
  const config = buildOAuthConformanceConfig({
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registration: "preregistered",
    authMode: "interactive",
    clientId: "client-id",
    clientSecret: "client-secret",
  });

  const snapshotConfig = buildOAuthLoginSnapshotConfig(config, {
    completed: false,
    serverUrl: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    registrationStrategy: "preregistered",
    protocolMode: "auto",
    registrationMode: "auto",
    authMode: "interactive",
    redirectUrl: "https://app.example.com/callback",
    currentStep: "received_access_token",
    authorizationPlan: {
      protocolMode: "auto",
      protocolVersion: "2025-06-18",
      registrationMode: "auto",
      registrationStrategy: "preregistered",
      status: "ready",
      blockerDetails: [],
      blockers: [],
      warnings: [],
      capabilities: {
        registrationStrategies: ["preregistered", "dcr"],
        supportsCimd: false,
        supportsDcr: true,
      },
      canonicalResource: "https://example.com/mcp",
      summary: "Using pre-registered client credentials.",
    },
    credentials: {
      refreshToken: "refresh-token",
    },
    state: {
      currentStep: "received_access_token",
      httpHistory: [],
      infoLogs: [],
    } as any,
  });

  assert.equal("url" in snapshotConfig, true);
  assert.equal(snapshotConfig.refreshToken, "refresh-token");
  assert.equal(snapshotConfig.clientId, "client-id");
  assert.equal(snapshotConfig.clientSecret, "client-secret");
});
