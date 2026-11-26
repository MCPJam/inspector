/**
 * Client rules for MCPJam as an MCP Apps host (ext-apps 2026-01-26).
 *
 * The apps conformance run (the code behind the `ui-*` checks) runs once per
 * era and every request it sends is recorded: on 2025-11-25 against the
 * stateful mock server, recorded server-side; on 2026-07-28 against the
 * dual-era fixture with its Apps surface, recorded at the fetch seam.
 */

import { beforeAll, describe, expect } from "vitest";
import {
  MCPAppsConformanceTest,
  type MCPAppsConformanceResult,
} from "../../src/apps-conformance/index.js";
import {
  CONFORMANCE_UI_RESOURCE_URI,
  startConformanceMockServer,
  type ConformanceMockRequest,
} from "../mock-servers/conformance-mcp-server.js";
import {
  createFixtureHandler,
  FIXTURE_APP_WIDGET_URI,
} from "../support/dual-era-fixture.js";
import {
  exercised,
  mayRule,
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  type WireRequest,
} from "./harness.js";

const UI_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

interface Message {
  method?: string;
  params?: Record<string, unknown>;
}

/** The `io.modelcontextprotocol/ui` settings a capabilities object declares, if any. */
function uiSettings(capabilities: unknown): Record<string, unknown> | undefined {
  const extensions = (capabilities as { extensions?: Record<string, unknown> } | undefined)
    ?.extensions;
  const settings = extensions?.[UI_EXTENSION];
  return settings && typeof settings === "object" ? (settings as Record<string, unknown>) : undefined;
}

let legacy: { result: MCPAppsConformanceResult; messages: Message[] };
let modern: { result: MCPAppsConformanceResult; requests: WireRequest[] };

beforeAll(async () => {
  const received: ConformanceMockRequest[] = [];
  const server = await startConformanceMockServer({
    onRequest: (record) => received.push(record),
  });
  try {
    const result = await new MCPAppsConformanceTest({
      url: server.url,
      timeout: 10_000,
      __suppressTelemetry: true,
    }).run();
    legacy = {
      result,
      messages: received.map((record) => (record.body ?? {}) as Message),
    };
  } finally {
    await server.stop();
  }

  const requests: WireRequest[] = [];
  const handler = createFixtureHandler({ apps: true });
  const result = await new MCPAppsConformanceTest({
    url: "http://localhost/mcp",
    mcpProtocolVersion: "2026-07-28",
    timeout: 10_000,
    baseFetch: recordingFetch((request) => handler.fetch(request), requests, () => "apps"),
    __suppressTelemetry: true,
  }).run();
  modern = { result, requests };
}, 60_000);

/** The client capabilities each modern tools/list declared. */
function modernToolsListCapabilities(): unknown[] {
  return modern.requests
    .filter((request) => rpcMethodOf(request) === "tools/list")
    .map((request) => (rpcOf(request)?.params?._meta as Record<string, unknown> | undefined)?.[
      CLIENT_CAPABILITIES
    ]);
}

describe("MCP Apps host rules", () => {
  ruleTest(
    "C071",
    "2025-11-25: initialize declares io.modelcontextprotocol/ui in the client capabilities",
    (ctx) => {
      const initializes = legacy.messages.filter((message) => message.method === "initialize");
      exercised(ctx, initializes.length > 0, "the apps run sent no initialize");
      for (const message of initializes) {
        expect(uiSettings(message.params?.capabilities)).toBeDefined();
      }
    },
  );

  ruleTest(
    "C071",
    "2026-07-28: every tools/list declares io.modelcontextprotocol/ui in its client capabilities",
    (ctx) => {
      const declared = modernToolsListCapabilities();
      exercised(ctx, declared.length > 0, "the apps run sent no tools/list");
      for (const capabilities of declared) {
        expect(uiSettings(capabilities)).toBeDefined();
      }
    },
  );

  ruleTest(
    "C072",
    "2025-11-25: the ui settings in initialize list the content types MCPJam supports",
    (ctx) => {
      const settings = legacy.messages
        .filter((message) => message.method === "initialize")
        .map((message) => uiSettings(message.params?.capabilities));
      exercised(ctx, settings.length > 0, "the apps run sent no initialize");
      for (const entry of settings) {
        expect(entry?.mimeTypes).toContain(MCP_APP_MIME_TYPE);
      }
    },
  );

  ruleTest(
    "C072",
    "2026-07-28: the ui settings on every tools/list list the content types MCPJam supports",
    (ctx) => {
      const declared = modernToolsListCapabilities();
      exercised(ctx, declared.length > 0, "the apps run sent no tools/list");
      for (const capabilities of declared) {
        expect(uiSettings(capabilities)?.mimeTypes).toContain(MCP_APP_MIME_TYPE);
      }
    },
  );

  mayRule(
    "C073",
    "MCPJam never prefetches or caches UI resources ahead of a render.",
  );

  function readCheckRan(result: MCPAppsConformanceResult): boolean {
    const status = result.checks.find((check) => check.id === "ui-resources-readable")?.status;
    return status !== undefined && status !== "skipped";
  }

  ruleTest(
    "C074",
    "2025-11-25: the UI resource a tool declares is fetched with resources/read for that URI",
    (ctx) => {
      exercised(ctx, readCheckRan(legacy.result), "the apps run fetched no UI resource");
      const reads = legacy.messages.filter((message) => message.method === "resources/read");
      expect(reads.map((message) => message.params?.uri)).toContain(CONFORMANCE_UI_RESOURCE_URI);
    },
  );

  ruleTest(
    "C074",
    "2026-07-28: the UI resource a tool declares is fetched with resources/read for that URI",
    (ctx) => {
      exercised(ctx, readCheckRan(modern.result), "the apps run fetched no UI resource");
      const reads = modern.requests.filter((request) => rpcMethodOf(request) === "resources/read");
      expect(reads.map((request) => rpcOf(request)?.params?.uri)).toContain(FIXTURE_APP_WIDGET_URI);
    },
  );
});
