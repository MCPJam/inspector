import { describe, expect, it, vi } from "vitest";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import type { HostConfigInputV2 } from "@/lib/client-config-v2";
import {
  changedClientSettings,
  emitClientSaveTelemetry,
} from "../client-save-telemetry";

const config = (
  overrides: Partial<HostConfigInputV2> = {},
): HostConfigInputV2 => ({
  ...emptyHostConfigInputV2(),
  ...overrides,
});

describe("changedClientSettings", () => {
  it("detects a name-only save without recording the name", () => {
    expect(
      changedClientSettings({
        savedName: "Before",
        draftName: "After",
        savedConfig: config(),
        draftConfig: config(),
      }),
    ).toEqual(["client.name"]);
  });

  it("distinguishes legacy and modern tool cancellation", () => {
    expect(
      changedClientSettings({
        savedName: "Client",
        draftName: "Client",
        savedConfig: config(),
        draftConfig: config({
          mcpProfile: {
            profileVersion: 1,
            toolCallCancellation: { modern: false },
          },
        }),
      }),
    ).toEqual(["mcp.tool_call_cancellation.modern"]);
  });

  it("returns each changed setting once for a multi-setting save", () => {
    expect(
      changedClientSettings({
        savedName: "Before",
        draftName: "After",
        savedConfig: config(),
        draftConfig: config({
          modelId: "anthropic/claude-sonnet-4-6",
          temperature: 0.2,
        }),
      }),
    ).toEqual(["client.name", "model", "temperature"]);
  });

  it("emits nothing when no setting changed", () => {
    const saved = config();
    expect(
      changedClientSettings({
        savedName: "Client",
        draftName: "Client",
        savedConfig: saved,
        draftConfig: structuredClone(saved),
      }),
    ).toEqual([]);
  });

  it("detects nested, array, and dynamic-record changes without returning values", () => {
    const changed = changedClientSettings({
      savedName: "Client",
      draftName: "Client",
      savedConfig: config(),
      draftConfig: config({
        builtInToolIds: ["secret-tool-id"],
        connectionDefaults: {
          headers: { Authorization: "secret-value" },
          requestTimeout: 60_000,
        },
        mcpProfile: {
          profileVersion: 1,
          apps: { sandbox: { browserStorage: { indexedDB: false } } },
        },
      }),
    });

    expect(changed).toEqual([
      "built_in_tools",
      "connection.headers",
      "connection.request_timeout",
      "mcp.apps.sandbox.browser_storage.indexed_db",
    ]);
    expect(JSON.stringify(changed)).not.toContain("secret");
  });
});

describe("emitClientSaveTelemetry", () => {
  it("keeps the summary event and emits one event per saved setting", () => {
    const capture = vi.fn();
    emitClientSaveTelemetry(capture, {
      clientId: "client-1",
      clientConfigId: "config-2",
      savedName: "Before",
      draftName: "After",
      savedConfig: config(),
      draftConfig: config({ temperature: 0.2 }),
    });

    expect(capture).toHaveBeenNthCalledWith(
      1,
      "client_config_saved",
      expect.objectContaining({ changed_fields: ["temperature"] }),
    );
    expect(capture).toHaveBeenNthCalledWith(
      2,
      "client_setting_saved",
      expect.objectContaining({ setting: "client.name" }),
    );
    expect(capture).toHaveBeenNthCalledWith(
      3,
      "client_setting_saved",
      expect.objectContaining({ setting: "temperature" }),
    );
  });

  it("does not leak changed values in setting events", () => {
    const capture = vi.fn();
    emitClientSaveTelemetry(capture, {
      clientId: "client-1",
      clientConfigId: "config-2",
      savedName: "Before",
      draftName: "private-client-name",
      savedConfig: config(),
      draftConfig: config({ systemPrompt: "private system prompt" }),
    });

    const settingEvents = capture.mock.calls.filter(
      ([event]) => event === "client_setting_saved",
    );
    expect(settingEvents).toHaveLength(2);
    expect(JSON.stringify(settingEvents)).not.toContain("private");
  });

  it("swallows capture failures and continues with later setting events", () => {
    const capture = vi.fn(() => {
      throw new Error("blocked");
    });
    expect(() =>
      emitClientSaveTelemetry(capture, {
        clientId: "client-1",
        clientConfigId: "config-2",
        savedName: "Before",
        draftName: "After",
        savedConfig: config(),
        draftConfig: config({ temperature: 0.2 }),
      }),
    ).not.toThrow();
    expect(capture).toHaveBeenCalledTimes(3);
  });
});
