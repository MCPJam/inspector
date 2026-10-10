import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProbeMcpServerResult, ServerDoctorResult } from "@mcpjam/sdk";
import { writeDebugArtifact } from "../src/lib/debug-artifact.js";
import { redactForTelemetry } from "../src/lib/redaction.js";
import {
  formatServerDoctorHuman,
  summarizeServerDoctorTarget,
} from "../src/lib/server-doctor.js";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../src/lib/rpc-logs.js";

function createProbeResult(
  overrides: Partial<ProbeMcpServerResult> = {},
): ProbeMcpServerResult {
  return {
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: {
      selected: "streamable-http",
      attempts: [],
    },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    initialize: {
      protocolVersion: "2025-11-25",
      serverInfo: { name: "Example" },
      capabilities: { tools: {} },
    },
    ...overrides,
  };
}

test("summarizeServerDoctorTarget describes HTTP and stdio targets without leaking values", () => {
  const httpTarget = summarizeServerDoctorTarget("https://example.com/mcp", {
    url: "https://example.com/mcp",
    accessToken: "secret-token",
    refreshToken: "refresh-token",
    clientSecret: "client-secret",
    requestInit: {
      headers: {
        Authorization: "Bearer hidden",
        "X-Test": "yes",
      },
    },
    timeout: 4_000,
  });

  const stdioTarget = summarizeServerDoctorTarget("node", {
    command: "node",
    args: ["server.js"],
    env: { API_KEY: "secret" },
    timeout: 4_000,
  });

  assert.equal(httpTarget.kind, "http");
  assert.deepEqual(httpTarget.headerNames.sort(), ["Authorization", "X-Test"]);
  assert.equal(httpTarget.hasAccessToken, true);
  assert.equal(httpTarget.hasRefreshToken, true);
  assert.equal(httpTarget.hasClientSecret, true);

  assert.equal(stdioTarget.kind, "stdio");
  assert.deepEqual(stdioTarget.commandArgs, ["server.js"]);
  assert.deepEqual(stdioTarget.envKeys, ["API_KEY"]);
});

test("attachCliRpcLogs redacts sensitive auth values", () => {
  const collector = createCliRpcLogCollector({ "__cli__": "example" });
  collector.rpcLogger({
    serverId: "__cli__",
    direction: "send",
    message: {
      headers: {
        Authorization: "Bearer super-secret-token",
        Cookie: "session=abc123",
      },
      body: {
        refresh_token: "refresh-secret",
        clientSecret: "client-secret-value",
        nested: {
          accessToken: "nested-access-token",
        },
        tokenCount: 42,
      },
      note: 'Authorization: Bearer abc.def.ghi refresh_token=refresh-me',
    },
  } as any);

  const payload = attachCliRpcLogs({ ok: true }, collector) as {
    _rpcLogs: Array<{ message: any }>;
  };
  const message = payload._rpcLogs[0]?.message;

  assert.equal(message.headers.Authorization, "[REDACTED]");
  assert.equal(message.headers.Cookie, "[REDACTED]");
  assert.equal(message.body.refresh_token, "[REDACTED]");
  assert.equal(message.body.clientSecret, "[REDACTED]");
  assert.equal(message.body.nested.accessToken, "[REDACTED]");
  assert.equal(message.body.tokenCount, 42);
  assert.match(message.note, /Authorization: \[REDACTED\]/);
});

test("attachCliRpcLogs preserves challenge headers and boolean summaries", () => {
  const collector = createCliRpcLogCollector({ "__cli__": "example" });
  collector.rpcLogger({
    serverId: "__cli__",
    direction: "receive",
    message: {
      target: {
        hasAccessToken: false,
        hasRefreshToken: true,
        hasClientSecret: false,
      },
      headers: {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
      },
    },
  } as any);

  const payload = attachCliRpcLogs({ ok: true }, collector) as {
    _rpcLogs: Array<{ message: any }>;
  };
  const message = payload._rpcLogs[0]?.message;

  assert.equal(message.target.hasAccessToken, false);
  assert.equal(message.target.hasRefreshToken, true);
  assert.equal(message.target.hasClientSecret, false);
  assert.equal(
    message.headers["WWW-Authenticate"],
    'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
  );
});

test("writeDebugArtifact persists JSON payloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-doctor-"));
  const artifactPath = path.join(directory, "doctor.json");
  const payload = {
    status: "ready",
    target: { label: "https://example.com/mcp" },
  };

  const writtenPath = await writeDebugArtifact(artifactPath, payload);
  const contents = await readFile(writtenPath, "utf8");

  assert.equal(path.isAbsolute(writtenPath), true);
  assert.deepEqual(JSON.parse(contents), payload);
});

test("formatServerDoctorHuman renders a concise summary and artifact path", () => {
  const result: ServerDoctorResult<import("../src/lib/server-doctor.js").ServerDoctorTargetSummary> = {
    target: {
      kind: "http",
      label: "https://example.com/mcp",
      url: "https://example.com/mcp",
      commandArgs: [],
      envKeys: [],
      headerNames: [],
      timeoutMs: 4_000,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasClientSecret: false,
    },
    generatedAt: "2026-04-11T00:00:00.000Z",
    status: "oauth_required",
    probe: createProbeResult({
      status: "oauth_required",
      oauth: {
        required: true,
        optional: false,
        registrationStrategies: ["dcr", "cimd"],
      },
    }),
    connection: {
      status: "skipped",
      detail: "Server requires OAuth before a connection can be established.",
    },
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    toolLints: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    skills: [],
    checks: {
      probe: {
        status: "error",
        detail: "Server requires OAuth before it can be connected.",
      },
      connection: {
        status: "skipped",
        detail: "Server requires OAuth before a connection can be established.",
      },
      initialization: {
        status: "skipped",
        detail: "Initialization info was not collected.",
      },
      capabilities: {
        status: "skipped",
        detail: "Capabilities were not collected.",
      },
      tools: {
        status: "skipped",
        detail: "Tools were not collected.",
      },
      toolHygiene: {
        status: "skipped",
        detail: "Tool hygiene lints did not run.",
      },
      resources: {
        status: "skipped",
        detail: "Resources were not collected.",
      },
      resourceTemplates: {
        status: "skipped",
        detail: "Resource templates were not collected.",
      },
      prompts: {
        status: "skipped",
        detail: "Prompts were not collected.",
      },
      skills: {
        status: "skipped",
        detail: "Skills were not collected.",
      },
    },
    error: {
      code: "OAUTH_REQUIRED",
      message:
        "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
    },
  };

  const rendered = formatServerDoctorHuman(result, {
    artifactPath: "/tmp/doctor.json",
  });

  assert.match(rendered, /^Status: oauth_required/m);
  assert.match(rendered, /^OAuth: required \(dcr, cimd\)$/m);
  assert.match(rendered, /^Artifact: \/tmp\/doctor\.json$/m);
  assert.doesNotMatch(rendered, /^Tool hygiene:/m);
});

test("formatServerDoctorHuman renders advisory tool hygiene warnings", () => {
  const result: ServerDoctorResult<import("../src/lib/server-doctor.js").ServerDoctorTargetSummary> = {
    target: {
      kind: "http",
      label: "https://example.com/mcp",
      url: "https://example.com/mcp",
      commandArgs: [],
      envKeys: [],
      headerNames: [],
      timeoutMs: 4_000,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasClientSecret: false,
    },
    generatedAt: "2026-04-11T00:00:00.000Z",
    status: "ready",
    probe: createProbeResult(),
    connection: { status: "connected", detail: "ok" },
    initInfo: null,
    capabilities: null,
    tools: [{ name: "insight-get" }],
    toolsMetadata: {},
    toolLints: [
      {
        rule: "unknowable-required-id",
        tools: ["insight-get"],
        param: "insightId",
        message:
          '"insightId" is required and looks like an opaque identifier, but nothing says where to get one.',
      },
      {
        rule: "unbounded-list-tool",
        tools: ["traces-list"],
        message: "Looks like a list/query tool with no limit parameter.",
      },
    ],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    checks: {
      probe: { status: "ok", detail: "ok" },
      connection: { status: "ok", detail: "ok" },
      initialization: { status: "ok", detail: "ok" },
      capabilities: { status: "ok", detail: "ok" },
      tools: { status: "ok", detail: "1 tool discovered." },
      toolHygiene: {
        status: "warn",
        detail:
          "2 hygiene warnings (advisory; does not affect readiness). See toolLints for details.",
      },
      resources: { status: "ok", detail: "0 resources discovered." },
      resourceTemplates: { status: "ok", detail: "0 resource templates discovered." },
      prompts: { status: "ok", detail: "0 prompts discovered." },
    },
    error: null,
  };

  const rendered = formatServerDoctorHuman(result);

  assert.match(rendered, /^Status: ready/m);
  assert.match(rendered, /^- toolHygiene: warn /m);
  assert.match(rendered, /^Tool hygiene: 2 warnings \(advisory; readiness is unaffected\)$/m);
  assert.match(rendered, /^- \[unknowable-required-id\] insight-get · insightId: /m);
  assert.match(rendered, /^- \[unbounded-list-tool\] traces-list: /m);
});

test("server doctor JSON payload redacts probe Authorization headers", () => {
  const probe = createProbeResult({
    transport: {
      selected: "streamable-http",
      attempts: [
        {
          name: "streamable_initialize",
          request: {
            method: "POST",
            url: "https://example.com/mcp",
            headers: {
              Authorization: "Bearer super-secret-token",
              Accept: "application/json",
            },
          },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          },
          durationMs: 12,
        },
      ],
    },
  });

  const redacted = redactForTelemetry({ probe }) as { probe: typeof probe };
  const attempt = redacted.probe.transport.attempts[0]!;
  assert.equal(attempt.request.headers.Authorization, "[REDACTED]");
  assert.equal(attempt.request.headers.Accept, "application/json");
});
