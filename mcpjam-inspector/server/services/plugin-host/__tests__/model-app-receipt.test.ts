import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelAppRegistry } from "../model-apps.js";
import { createPluginInstanceControlPort } from "../instance-store.js";
import { RequestOwnedToolInvoker } from "../request-invoker.js";
import { createPluginAdmissionNoop, type PluginInvocationPorts } from "../invocation.js";
import {
  pluginInvocationOwnerHash,
  type DurableInvocationReceipt,
  type PluginInvocationReceiptPort,
} from "../receipt-store.js";
import type { PluginFormOwner } from "../instances.js";
import { PLUGIN_MODEL_APP_META } from "../../../../shared/plugin-model-app.js";

afterEach(() => vi.useRealTimers());
const source: PluginFormOwner = {
  owner: { actorId: "actor", projectId: "project", workspaceId: "workspace",
    instanceId: "original", generation: 1, serverId: "server", bindingId: "binding",
    placement: "interactive" },
  subject: "subject", hostId: "host", hostRevision: "host-revision",
  serverIdentity: { kind: "standalone", serverId: "server" },
};
const actor = { ...source.owner, subject: source.subject };
const tokenOf = (value: unknown) => z.object({ _meta: z.object({
  [PLUGIN_MODEL_APP_META]: z.object({ instanceToken: z.string() }),
}) }).parse(value)._meta[PLUGIN_MODEL_APP_META].instanceToken;

function receiptStore() {
  let saved: DurableInvocationReceipt | null = null;
  const port: PluginInvocationReceiptPort = {
    read: async () => saved,
    claim: async (_id, input) => {
      if (saved) return { claimed: false, receipt: saved };
      saved = {
        fingerprint: input.fingerprint, revision: input.revision,
        expiresAt: Date.now() + 60_000,
        legs: [{ round: 0, fingerprint: input.fingerprint,
          state: input.dispatch ? "dispatched" : "reserved" }],
      };
      return { claimed: true, receipt: saved };
    },
    write: async (_id, input) => {
      if (!saved || input.state === "refused") throw new Error("Unexpected receipt write");
      saved = { ...saved, legs: [{ round: 0, fingerprint: saved.fingerprint,
        state: input.state, ...(input.valueJson ? { valueJson: input.valueJson } : {}) }] };
    },
  };
  return { port, read: () => saved };
}

function publication(registry: ModelAppRegistry, receipts: PluginInvocationReceiptPort) {
  const execute = vi.fn(async () => registry.publish(
    { content: [] }, source, "tool", "revision", { ui: { resourceUri: "ui://app" } },
    new AbortController().signal,
  ));
  const ports: PluginInvocationPorts = {
    receipts,
    authorize: async () => ({ owner: source.owner, revision: "revision", enabled: true,
      tool: { name: "tool" }, allowedOrigins: ["model"], requiresApproval: false }),
    approve: async () => false, admit: createPluginAdmissionNoop(), execute,
    classifyFailure: () => "unknown",
  };
  const invoker = new RequestOwnedToolInvoker(source.owner, () => {});
  return { execute, close: () => invoker.close(),
    invoke: () => invoker.invoke(ports, "model", "call", { name: "tool" }) };
}

it.each(["close", "expiry"] as const)(
  "keeps the receipt's original App token dead after %s and process replacement",
  async (end) => {
    vi.useFakeTimers();
    const signal = new AbortController().signal;
    const store = receiptStore();
    const registry = new ModelAppRegistry(100);
    const first = publication(registry, store.port);
    const result = await first.invoke();
    const token = tokenOf(result);
    expect(JSON.parse(store.read()!.legs[0]!.valueJson!)).toEqual(result);
    // Live, the published App restores in a process that never saw it.
    await new ModelAppRegistry(100).restore(token, actor, signal);
    if (end === "close") await registry.close(token, actor, signal);
    else vi.advanceTimersByTime(101);
    expect(await first.invoke()).toEqual(result);
    expect(first.execute).toHaveBeenCalledOnce();
    await expect(registry.restore(token, actor, signal)).rejects.toThrow(
      "MODEL_APP_UNAVAILABLE",
    );
    const replacement = new ModelAppRegistry();
    const cold = publication(replacement, store.port);
    expect(await cold.invoke()).toEqual(result);
    expect(cold.execute).not.toHaveBeenCalled();
    await expect(replacement.restore(token, actor, signal)).rejects.toThrow(
      "MODEL_APP_UNAVAILABLE",
    );
    cold.close(); first.close();
  },
);

it("replays an App call completed in one process from another, under the same receipt owner", async () => {
  const signal = new AbortController().signal;
  const first = new ModelAppRegistry();
  const token = tokenOf(await publication(first, receiptStore().port).invoke());
  // Another process: its own module graph, sharing only the control store.
  vi.resetModules();
  const other = await import("../model-apps.js");
  const second = new other.ModelAppRegistry(undefined, undefined, undefined,
    (identity) => createPluginInstanceControlPort(identity));
  const [a, b] = await Promise.all([
    first.restore(token, actor, signal), second.restore(token, actor, signal),
  ]);
  // Receipts are keyed by the restored owner, so both processes share them.
  const ownerHash = pluginInvocationOwnerHash(a.owner.owner, a.owner.subject);
  expect(pluginInvocationOwnerHash(b.owner.owner, b.owner.subject)).toBe(ownerHash);
  const receipts = new Map<string, ReturnType<typeof receiptStore>>();
  const execute = vi.fn(async () => ({ content: [{ type: "text", text: "drawn" }] }));
  const call = (app: Pick<typeof a, "owner" | "invoker">) => {
    const key = pluginInvocationOwnerHash(app.owner.owner, app.owner.subject);
    if (!receipts.has(key)) receipts.set(key, receiptStore());
    const ports: PluginInvocationPorts = {
      receipts: receipts.get(key)!.port,
      authorize: async (owner) => ({ owner, revision: "revision", enabled: true,
        tool: { name: "draw" }, allowedOrigins: ["app"], requiresApproval: false }),
      approve: async () => false, admit: createPluginAdmissionNoop(), execute,
      classifyFailure: () => "unknown",
    };
    return app.invoker.invoke(ports, "app", "call-1", { name: "draw" });
  };
  const result = await call(a);
  expect(await call(b)).toEqual(result);
  expect(execute).toHaveBeenCalledOnce();
  await first.close(token, actor, signal);
});
