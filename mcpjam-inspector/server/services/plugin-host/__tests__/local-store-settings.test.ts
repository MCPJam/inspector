import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPluginInstanceControlPort } from "../instance-store.js";
import {
  PluginInstanceRegistry,
  type PluginInstanceBinding,
} from "../instances.js";
import { parsePluginSettingsEnvelope } from "../settings-state.js";
import { pluginInvocationOwnerHash } from "../receipt-store.js";
import parity from "./fixtures/plugin-settings-envelope-parity.json";

/**
 * The local store keeps a Settings App's document and its children under the
 * backend's rules (`pluginInstanceControls`). The envelope cases are the same
 * file the backend tests run, pinned in its mirror manifest.
 */
const h = (value: string) => createHash("sha256").update(value).digest("hex");
const signal = () => AbortSignal.timeout(5000);
const settingsBinding = (
  activation: Partial<PluginInstanceBinding["activation"]> = {},
): PluginInstanceBinding => ({
  runtime: "chatgpt",
  hostId: "host",
  hostRevision: "rev",
  serverId: "server",
  bindingId: "binding",
  resourceUri: "ui://mcpjam/structured-settings",
  serverIdentity: { kind: "standalone", serverId: "server" },
  activation: {
    selector: { kind: "settings" },
    toolName: "read",
    revision: "read-rev",
    settings: { readTool: "read", updateTool: "save", revision: "settings-rev" },
    ...activation,
  },
});

async function openSettings(binding = settingsBinding()) {
  const identity = {
    actorId: randomUUID(),
    projectId: "local-project",
    workspaceId: "local-workspace",
    subject: "local-subject",
  };
  const port = createPluginInstanceControlPort(identity, {
    env: {},
    hosted: false,
  })!;
  // A one-minute lease keeps the Settings App's expiry well inside the
  // store's 30-minute ceiling, so a child that outlives it is refused for
  // that reason, however fast the test runs.
  const opened = await new PluginInstanceRegistry(
    undefined,
    60_000,
  ).openActivationPersistent(
    identity,
    binding,
    signal(),
    port,
  );
  const parentOwnerHash = pluginInvocationOwnerHash(
    opened.instance.owner,
    identity.subject,
  );
  const child = (overrides: Record<string, unknown> = {}) =>
    port.issueChild!(
      (overrides.childToken as string) ?? "c".repeat(43),
      {
        childAnchorHash: h(`anchor-${identity.actorId}`),
        childParentOwnerHash: parentOwnerHash,
        childParentScopeHash: h("scope"),
        childSourceHash: h(`source-${identity.actorId}`),
        childBindingHash: h("binding"),
        childSettingsAction: { name: "open-panel", revision: "r1" },
        ownerHash: h(`child-owner-${identity.actorId}`),
        snapshotJson: JSON.stringify({ kind: "settings-child", version: 1 }),
        expiresAt: opened.expiresAt - 1000,
        ...overrides,
      },
      signal(),
    );
  return { identity, port, opened, child };
}

describe("a Settings App's row in the local store", () => {
  it("keeps a versioned document, accepts a lost-reply retry and refuses a stale write", async () => {
    const { port, opened } = await openSettings();
    const first = JSON.stringify(parity.cases[0].envelope);
    const written = await port.writeSettings!(
      opened.token,
      { expectedVersion: 0, settingsJson: first },
      signal(),
    );
    expect(written).toMatchObject({ settingsVersion: 1, settingsJson: first });
    expect(
      await port.writeSettings!(
        opened.token,
        { expectedVersion: 0, settingsJson: first },
        signal(),
      ),
    ).toMatchObject({ settingsVersion: 1 });
    await expect(
      port.writeSettings!(
        opened.token,
        { expectedVersion: 0, settingsJson: "{}" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_CONTROL_CONFLICT" });
    const read = await port.read(opened.token, signal());
    expect(read).toMatchObject({ settingsVersion: 1, settingsJson: first });
    expect(parsePluginSettingsEnvelope(read!.settingsJson!).document.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "units" })]),
    );
    await port.close(opened.token, signal());
    await expect(
      port.writeSettings!(
        opened.token,
        { expectedVersion: 1, settingsJson: first },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "INSTANCE_UNAVAILABLE" });
  });

  it("refuses settings state on an App that is not a Settings App", async () => {
    const identity = {
      actorId: randomUUID(),
      projectId: "local-project",
      workspaceId: "local-workspace",
      subject: "local-subject",
    };
    const port = createPluginInstanceControlPort(identity, {
      env: {},
      hosted: false,
    })!;
    await expect(
      port.issueActivation!(
        "g".repeat(43),
        {
          anchor: "global-anchor",
          bindingHash: h("global-binding"),
          renewable: true,
          snapshotJson: JSON.stringify({
            instance: { activation: { selector: { kind: "global" } } },
          }),
          ownerHash: h("global-owner"),
          expiresAt: Date.now() + 60_000,
          settings: true,
        },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "INVALID_SETTINGS_CONTROL" });
  });

  it.each([
    { name: "owns context", original: (token: string) => ({ contextToken: token }) },
    {
      name: "is not a Settings App",
      original: () => ({
        snapshotJson: JSON.stringify({
          instance: { activation: { selector: { kind: "global" } } },
        }),
      }),
    },
  ])("leaves the slot off an App that $name when it is opened again", async ({ original }) => {
    const actorId = randomUUID();
    const port = createPluginInstanceControlPort(
      {
        actorId,
        projectId: "local-project",
        workspaceId: "local-workspace",
        subject: "local-subject",
      },
      { env: {}, hosted: false },
    )!;
    const issue = (token: string, slot: object) =>
      port.issueActivation!(
        token,
        {
          anchor: "settings-anchor",
          bindingHash: h("settings-binding"),
          renewable: true,
          snapshotJson: JSON.stringify({
            instance: { activation: { selector: { kind: "settings" } } },
          }),
          ownerHash: h(`owner-${actorId}-${token}`),
          expiresAt: Date.now() + 60_000,
          ...slot,
        },
        signal(),
      );
    const first = "a".repeat(43);
    await issue(first, original(first));
    const reopened = await issue("b".repeat(43), { settings: true });
    expect(reopened.token).toBe(first);
    expect(reopened.control.settingsVersion).toBeUndefined();
    await expect(
      port.writeSettings!(
        first,
        { expectedVersion: 0, settingsJson: "{}" },
        signal(),
      ),
    ).rejects.toMatchObject({ code: "INSTANCE_UNAVAILABLE" });
  });

  it("returns the original child to a retry and ends it with its Settings App", async () => {
    const { port, opened, child } = await openSettings();
    await port.writeSettings!(
      opened.token,
      { expectedVersion: 0, settingsJson: JSON.stringify(parity.cases[0].envelope) },
      signal(),
    );
    const first = await child();
    expect(first.token).toBe("c".repeat(43));
    expect((await child({ childToken: "d".repeat(43) })).token).toBe(first.token);
    expect(await port.read(first.token, signal())).toMatchObject({
      snapshotJson: JSON.stringify({ kind: "settings-child", version: 1 }),
    });
    await expect(child({ expiresAt: opened.expiresAt + 1, childAnchorHash: h("late") }))
      .rejects.toMatchObject({ code: "INSTANCE_PRIVATE_PARENT_UNAVAILABLE" });
    await port.close(opened.token, signal());
    await expect(port.read(first.token, signal())).rejects.toMatchObject({
      code: "INSTANCE_PRIVATE_PARENT_UNAVAILABLE",
    });
  });

  it.each(parity.cases)(
    "admits only what the stored envelope lists: $name",
    async ({ envelope, child: action, admitted }) => {
      const { port, opened, child } = await openSettings();
      // Every envelope the backend reads is one this Inspector can read back.
      expect(() =>
        parsePluginSettingsEnvelope(JSON.stringify(envelope)),
      ).not.toThrow();
      await port.writeSettings!(
        opened.token,
        { expectedVersion: 0, settingsJson: JSON.stringify(envelope) },
        signal(),
      );
      const outcome = child({ childSettingsAction: action });
      if (admitted) await expect(outcome).resolves.toMatchObject({});
      else
        await expect(outcome).rejects.toMatchObject({
          code: "INSTANCE_PRIVATE_PARENT_UNAVAILABLE",
        });
    },
  );
});
