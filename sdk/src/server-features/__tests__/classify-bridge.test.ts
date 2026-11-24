import { describe, expect, it } from "vitest";
import {
  APPS_BRIDGE_FEATURE_IDS,
  classifyAppsBridgeMessage,
  type BridgeMessage,
} from "../classify-bridge.js";
import { OBSERVABLE_FEATURE_IDS } from "../classify-frame.js";
import { FRAME_FIXTURES } from "./frame-fixtures.js";

interface BridgeFixture {
  name: string;
  entry: BridgeMessage;
  requestMethod?: string;
  expect: readonly string[];
}

function viewRequest(method: string, params: Record<string, unknown> = {}) {
  return {
    direction: "ui-to-host" as const,
    method,
    message: { jsonrpc: "2.0", id: 1, method, params },
  };
}

function hostNotification(
  method: string,
  params: Record<string, unknown> = {}
) {
  return {
    direction: "host-to-ui" as const,
    method,
    message: { jsonrpc: "2.0", method, params },
  };
}

const BRIDGE_FIXTURES: readonly BridgeFixture[] = [
  {
    name: "view calls a server tool",
    entry: viewRequest("tools/call", { name: "private", arguments: {} }),
    expect: ["apps.app-tools-call"],
  },
  {
    name: "view reads a host-managed file",
    entry: viewRequest("resources/read", {
      uri: "file:///private",
      _meta: { "openai/resource": { representation: "text" } },
    }),
    expect: ["apps.app-resources-read", "openai.file-resources"],
  },
  {
    name: "view opens a link",
    entry: viewRequest("ui/open-link", { url: "https://example.test" }),
    expect: ["apps.view-requests"],
  },
  {
    name: "view sends an OpenAI message",
    entry: viewRequest("ui/message", {
      role: "user",
      content: [{ type: "text", text: "private" }],
      _meta: { "openai/message": { target: "new" } },
    }),
    expect: ["apps.view-requests", "openai.message"],
  },
  {
    name: "a log the host sends is not a view notification",
    entry: hostNotification("notifications/message", { level: "info" }),
    expect: [],
  },
  {
    name: "view log message",
    entry: {
      direction: "ui-to-host",
      method: "notifications/message",
      message: { jsonrpc: "2.0", method: "notifications/message", params: {} },
    },
    expect: ["apps.view-notifications"],
  },
  {
    name: "view initializes with display modes and its own tools",
    entry: viewRequest("ui/initialize", {
      appInfo: { name: "private", version: "1" },
      appCapabilities: {
        availableDisplayModes: ["inline", "fullscreen"],
        tools: { listChanged: true },
      },
    }),
    expect: ["apps.display-modes", "apps.app-provided-tools"],
  },
  {
    name: "view downloads a file",
    entry: viewRequest("ui/download-file", { uri: "file:///private" }),
    expect: ["apps.download-file-teardown"],
  },
  {
    name: "view writes a file",
    entry: viewRequest("openai/resources/write", { uri: "file:///x" }),
    expect: ["openai.file-resources"],
  },
  {
    name: "view opens a local file",
    entry: viewRequest("openai/files/open", { path: "/private" }),
    expect: ["openai.files"],
  },
  {
    name: "host sends a tool result with text",
    entry: hostNotification("ui/notifications/tool-result", {
      content: [{ type: "text", text: "private" }],
      structuredContent: {},
    }),
    expect: ["apps.host-notifications", "apps.text-fallback"],
  },
  {
    name: "host sends tool input",
    entry: hostNotification("ui/notifications/tool-input", { arguments: {} }),
    expect: ["apps.host-notifications"],
  },
  {
    name: "host records calling the view's own tool",
    entry: {
      direction: "host-to-ui",
      method: "tools/call",
      message: { toolName: "private", result: { content: [] } },
    },
    expect: ["apps.app-provided-tools"],
  },
  {
    name: "view answers the host's tools/list",
    entry: {
      direction: "ui-to-host",
      method: "tools/list",
      message: { jsonrpc: "2.0", id: 4, result: { tools: [] } },
    },
    expect: ["apps.app-provided-tools"],
  },
  {
    name: "host acknowledges an OpenAI model context update",
    entry: {
      direction: "host-to-ui",
      method: "result",
      message: {
        jsonrpc: "2.0",
        id: 2,
        result: { _meta: { "openai/modelContext": { updateId: "u1" } } },
      },
    },
    requestMethod: "ui/update-model-context",
    expect: ["openai.model-context"],
  },
];

const SILENT: readonly BridgeFixture[] = [
  {
    name: "a plain model context acknowledgment",
    entry: {
      direction: "host-to-ui",
      method: "result",
      message: { jsonrpc: "2.0", id: 2, result: {} },
    },
    requestMethod: "ui/update-model-context",
    expect: [],
  },
  {
    name: "a tool result without text",
    entry: hostNotification("ui/notifications/tool-result", {
      structuredContent: {},
    }),
    expect: ["apps.host-notifications"],
  },
  {
    name: "an unknown view method",
    entry: viewRequest("vendor/private"),
    expect: [],
  },
  {
    name: "not an object",
    entry: { direction: "ui-to-host", method: "unknown", message: "text" },
    expect: [],
  },
];

function sorted(ids: readonly string[]) {
  return [...ids].sort();
}

describe("classifyAppsBridgeMessage", () => {
  it.each(
    [...BRIDGE_FIXTURES, ...SILENT].map(
      (fixture) => [fixture.name, fixture] as const
    )
  )("%s", (_name, fixture) => {
    expect(
      sorted(classifyAppsBridgeMessage(fixture.entry, fixture.requestMethod))
    ).toEqual(sorted(fixture.expect));
  });

  it("emits only observable ids that the bridge alone can show", () => {
    for (const id of APPS_BRIDGE_FEATURE_IDS)
      expect(OBSERVABLE_FEATURE_IDS.has(id), id).toBe(true);
    for (const fixture of BRIDGE_FIXTURES)
      for (const id of fixture.expect)
        expect(APPS_BRIDGE_FEATURE_IDS.has(id), `${fixture.name}: ${id}`).toBe(
          true
        );
  });

  it("covers every bridge id", () => {
    const emitted = new Set(
      BRIDGE_FIXTURES.flatMap((fixture) => fixture.expect)
    );
    expect(
      [...APPS_BRIDGE_FEATURE_IDS].filter((id) => !emitted.has(id))
    ).toEqual([]);
  });

  it("together with the frame classifier covers every observable id", () => {
    const emitted = new Set([
      ...FRAME_FIXTURES.flatMap((fixture) => fixture.expect),
      ...BRIDGE_FIXTURES.flatMap((fixture) => fixture.expect),
    ]);
    expect(
      [...OBSERVABLE_FEATURE_IDS].filter((id) => !emitted.has(id))
    ).toEqual([]);
  });

  it("returns ids, never payload strings", () => {
    const ids = BRIDGE_FIXTURES.flatMap((fixture) =>
      classifyAppsBridgeMessage(fixture.entry, fixture.requestMethod)
    );
    expect(JSON.stringify(ids)).not.toContain("private");
  });
});
