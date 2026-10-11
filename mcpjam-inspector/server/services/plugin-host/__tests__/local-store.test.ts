import { describe, expect, it, vi } from "vitest";
import { LocalPluginControlStore, pluginLocalStoresEnabled } from "../local-store.js";
import { createPluginInstanceControlPort } from "../instance-store.js";
import {
  PluginInstanceRegistry,
  type PluginInstanceBinding,
} from "../instances.js";
import { PLUGIN_INSTANCE_CONTROL_PATH } from "../../../../shared/plugin-invocation-receipts.js";

const identity = {
  actorId: "local-actor",
  projectId: "local-project",
  workspaceId: "local-workspace",
  subject: "local-subject",
};
const binding: PluginInstanceBinding = {
  runtime: "chatgpt",
  hostId: "host",
  hostRevision: "rev",
  serverId: "server",
  bindingId: "binding",
  resourceUri: "ui://app",
  serverIdentity: { kind: "standalone", serverId: "server" },
  contextEnabled: true,
  activation: {
    selector: { kind: "global" },
    toolName: "library",
    revision: "tool-rev",
  },
};
const signal = () => AbortSignal.timeout(5000);

describe("local installs keep App controls in-process", () => {
  it("is on only for local installs without a service token", () => {
    expect(pluginLocalStoresEnabled({}, false)).toBe(true);
    expect(pluginLocalStoresEnabled({ INSPECTOR_SERVICE_TOKEN: "t" }, false)).toBe(
      false,
    );
    expect(pluginLocalStoresEnabled({}, true)).toBe(false);
  });

  it("opens, restores, renews, updates context and closes an App without the backend", async () => {
    const fetchImpl = vi.fn();
    const port = createPluginInstanceControlPort(identity, {
      env: {},
      hosted: false,
      fetchImpl,
    })!;
    const registry = new PluginInstanceRegistry();
    const opened = await registry.openActivationPersistent(
      identity,
      binding,
      signal(),
      port,
    );
    // Same activation on reopen, including from a cold registry.
    const again = await new PluginInstanceRegistry().openActivationPersistent(
      identity,
      binding,
      signal(),
      port,
    );
    expect(again.token).toBe(opened.token);
    expect(again.instance.activation.operationId).toBe(
      opened.instance.activation.operationId,
    );
    const changed = await registry.changeContextPersistent(
      opened.token,
      identity,
      {
        kind: "update",
        request: {
          operationId: "op-1",
          sequence: 1,
          params: { content: [{ type: "text", text: "local" }] },
        },
      },
      signal(),
      async () => {},
      port,
    );
    expect(changed.snapshot.state?.content).toEqual([
      { type: "text", text: "local" },
    ]);
    // Foreign identities never see this App.
    const foreign = createPluginInstanceControlPort(
      { ...identity, subject: "other" },
      { env: {}, hosted: false },
    )!;
    await expect(foreign.read(opened.token, signal())).resolves.toBeNull();
    await registry.closePersistent(opened.token, identity, signal(), port);
    await expect(
      new PluginInstanceRegistry().getPersistent(
        opened.token,
        identity,
        signal(),
        port,
      ),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces expiry, renewal limits and the context version contract", async () => {
    let now = 1_000_000;
    const store = new LocalPluginControlStore(() => now);
    const request = store.handler(PLUGIN_INSTANCE_CONTROL_PATH, "UNAVAILABLE");
    const identityHash = "a".repeat(64);
    const controlHash = "b".repeat(64);
    const token = "t".repeat(43);
    const issued = await request(
      {
        action: "issue",
        identityHash,
        controlHash,
        ownerHash: "c".repeat(64),
        snapshotJson: JSON.stringify({ instance: { activation: {} } }),
        expiresAt: now + 1000,
        contextToken: token,
        activation: {
          token,
          anchorHash: "d".repeat(64),
          bindingHash: "e".repeat(64),
          renewable: true,
        },
      },
      signal(),
    );
    expect(issued).toMatchObject({ token, control: { contextVersion: 0 } });
    await expect(
      request(
        { action: "context", identityHash, controlHash, expectedVersion: 1, contextJson: "{}" },
        signal(),
      ),
    ).rejects.toThrow("INSTANCE_CONTEXT_CONFLICT");
    await expect(
      request(
        { action: "renew", identityHash, controlHash, expiresAt: now + 31 * 60_000 },
        signal(),
      ),
    ).rejects.toThrow("INVALID_INSTANCE_CONTROL");
    await request(
      { action: "renew", identityHash, controlHash, expiresAt: now + 5000 },
      signal(),
    );
    now += 2000;
    await expect(
      request({ action: "read", identityHash, controlHash }, signal()),
    ).resolves.toMatchObject({ control: { expiresAt: 1_005_000 } });
    now += 4000;
    await expect(
      request({ action: "read", identityHash, controlHash }, signal()),
    ).rejects.toThrow("INSTANCE_UNAVAILABLE");
  });
  it("refuses to renew unattended runs and past host-selected file bytes", async () => {
    let now = 1_000_000;
    const store = new LocalPluginControlStore(() => now);
    const request = store.handler(PLUGIN_INSTANCE_CONTROL_PATH, "UNAVAILABLE");
    const identityHash = "a".repeat(64);
    let seed = 0;
    const issue = async (snapshot: unknown) => {
      seed++;
      const controlHash = seed.toString(16).padStart(64, "0");
      const token = String.fromCharCode(96 + seed).repeat(43);
      await request(
        {
          action: "issue",
          identityHash,
          controlHash,
          ownerHash: (seed + 10).toString(16).padStart(64, "0"),
          snapshotJson: JSON.stringify(snapshot),
          expiresAt: now + 1000,
          activation: {
            token,
            anchorHash: (seed + 20).toString(16).padStart(64, "0"),
            bindingHash: "e".repeat(64),
            renewable: false,
          },
        },
        signal(),
      );
      return (expiresAt: number) =>
        request({ action: "renew", identityHash, controlHash, expiresAt }, signal());
    };
    const unattended = await issue({ kind: "unattended-run", activation: {} });
    await expect(unattended(now + 2000)).rejects.toThrow(
      "INVALID_INSTANCE_CONTROL",
    );
    const owned = {
      name: "upload.stl",
      mimeType: "model/stl",
      size: 1,
      sha256: "f".repeat(64),
      relativePath: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/upload.stl",
      resourceId: "f".repeat(64),
      ownership: {
        version: 1,
        name: `mcpjam-form-${"f".repeat(64)}`,
        identity: { dev: "1", ino: "2" },
        createdAt: now,
        expiresAt: now + 30 * 60_000,
        bindingDigest: "f".repeat(64),
        bytes: 1,
      },
    };
    const viewer = await issue({ instance: { activation: { file: owned } } });
    // Within the file's ownership the lease extends; past it, it never does.
    await expect(viewer(now + 20 * 60_000)).resolves.toBeDefined();
    now += 15 * 60_000;
    await expect(viewer(now + 30 * 60_000)).rejects.toThrow(
      "INVALID_INSTANCE_CONTROL",
    );
  });
  it("renews a writable saved-file viewer past its first 30 minutes, like the backend", async () => {
    let now = 1_000_000;
    const store = new LocalPluginControlStore(() => now);
    const request = store.handler(PLUGIN_INSTANCE_CONTROL_PATH, "UNAVAILABLE");
    const identityHash = "a".repeat(64);
    const controlHash = "9".repeat(64);
    const token = "v".repeat(43);
    // A writable viewer is a saved resource with a local target; only
    // host-selected bytes carry an ownership deadline a lease can't pass.
    const file = {
      kind: "saved-resource",
      version: 1,
      uri: "cad://part",
      name: "part.stl",
      localTarget: {
        root: "/fixture",
        relativePath: "part.stl",
        uri: "cad://part",
        exclusiveWrites: true,
      },
    };
    await request(
      {
        action: "issue",
        identityHash,
        controlHash,
        ownerHash: "8".repeat(64),
        snapshotJson: JSON.stringify({
          instance: {
            activation: {
              selector: { kind: "file", requestId: crypto.randomUUID() },
              file,
            },
          },
        }),
        expiresAt: now + 30 * 60_000,
        activation: {
          token,
          anchorHash: "7".repeat(64),
          bindingHash: "e".repeat(64),
          renewable: false,
        },
      },
      signal(),
    );
    for (let round = 0; round < 6; round++) {
      now += 10 * 60_000;
      await expect(
        request(
          { action: "renew", identityHash, controlHash, expiresAt: now + 30 * 60_000 },
          signal(),
        ),
      ).resolves.toMatchObject({ control: { expiresAt: now + 30 * 60_000 } });
    }
    // An hour in, the same activation is still live.
    await expect(
      request({ action: "read", identityHash, controlHash }, signal()),
    ).resolves.toMatchObject({ control: { expiresAt: now + 30 * 60_000 } });
  });
});
