import { expect, it } from "vitest";
import { settingsOperation } from "../settings-operation";
import { parsePluginSettingsDocument } from "../../../../shared/plugin-settings";
import { settingsFixture } from "../../../../shared/__tests__/plugin-settings-fixture";
import type { PluginPreviewInstance } from "../instances";
const instance: PluginPreviewInstance = {
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive",
  },
  subject: "subject",
  hostId: "host",
  hostRevision: "revision",
  resourceUri: "ui://settings",
  serverIdentity: { kind: "standalone", serverId: "server" },
  activation: {
    selector: { kind: "settings" },
    operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    toolName: "read",
    revision: "revision",
    settings: { readTool: "read", updateTool: "save", revision: "revision" },
  },
};
const document = parsePluginSettingsDocument(settingsFixture());
it("derives immutable read/update/action wire arguments from the original Settings contract", () => {
  expect(
    settingsOperation(instance, { method: "read" }, "op", undefined),
  ).toMatchObject({
    origin: "settings",
    params: { name: "read", arguments: {} },
  });
  expect(
    settingsOperation(
      instance,
      { method: "update", set: { enabled: false, count: 0 } },
      "op",
      document,
    ),
  ).toMatchObject({
    params: { name: "save", arguments: { set: { enabled: false, count: 0 } } },
    source: {
      selector: { kind: "settings" },
      activationId: instance.activation.operationId,
    },
  });
  expect(
    settingsOperation(
      instance,
      { method: "action", toolName: "reset" },
      "op",
      document,
    ),
  ).toMatchObject({
    origin: "settings",
    params: { name: "reset", arguments: {} },
  });
  expect(() =>
    settingsOperation(
      instance,
      { method: "update", set: { count: "bad" } },
      "op",
      document,
    ),
  ).toThrow();
});
it("keeps the exact child and App call params in the operation binding", () => {
  const intent = {
    method: "app/call" as const,
    childToken: "child",
    params: { name: "review", arguments: { enabled: false, count: 0 } },
  };
  expect(settingsOperation(instance, intent, "op", document)).toMatchObject({
    origin: "app",
    params: intent.params,
    source: { activationId: "child" },
  });
  expect(
    settingsOperation(
      instance,
      { ...intent, childToken: "another" },
      "op",
      document,
    ),
  ).not.toEqual(settingsOperation(instance, intent, "op", document));
});
