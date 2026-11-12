import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ModelAppRegistry } from "../model-apps.js";
import { RequestOwnedToolInvoker } from "../request-invoker.js";
import { createPluginAdmissionNoop, type PluginInvocationPorts } from "../invocation.js";
import type { DurableInvocationReceipt, PluginInvocationReceiptPort } from "../receipt-store.js";
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
    const store = receiptStore();
    const registry = new ModelAppRegistry(100);
    const first = publication(registry, store.port);
    const result = await first.invoke();
    const token = tokenOf(result);
    expect(JSON.parse(store.read()!.legs[0]!.valueJson!)).toEqual(result);
    if (end === "close") registry.close(token, actor);
    else vi.advanceTimersByTime(101);
    expect(await first.invoke()).toEqual(result);
    expect(first.execute).toHaveBeenCalledOnce();
    expect(() => registry.get(token, actor)).toThrow();
    const replacement = new ModelAppRegistry();
    const cold = publication(replacement, store.port);
    expect(await cold.invoke()).toEqual(result);
    expect(cold.execute).not.toHaveBeenCalled();
    expect(() => replacement.get(token, actor)).toThrow();
    cold.close(); first.close();
  },
);
