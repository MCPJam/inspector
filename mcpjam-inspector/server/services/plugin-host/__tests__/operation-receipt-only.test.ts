import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { RequestOwnedToolInvoker } from "../request-invoker";
import { receiptOnlyPorts } from "../operation-authorization";
import { AuthorizedToolInvoker } from "../invocation";
import type { PluginInvocationPorts } from "../invocation";
const owner = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  instanceId: "instance",
  generation: 1,
  serverId: "server",
  bindingId: "binding",
  placement: "interactive" as const,
};
function ports(): PluginInvocationPorts {
  return {
    authorize: vi.fn(async () => ({
      owner,
      revision: "revision",
      enabled: true,
      tool: { name: "review" },
      allowedOrigins: ["app" as const],
      requiresApproval: false,
    })),
    approve: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    execute: vi.fn(async () => ({ content: [] })),
    metadata: vi.fn(async () => ({})),
    classifyFailure: () => "unknown",
    receipts: {
      read: vi.fn(async () => null),
      claim: vi.fn(async () => {
        throw new Error("A recovery must not claim");
      }),
      write: vi.fn(async () => {}),
    },
  };
}
it("does not create a receipt, request approval or execute when recovery has no receipt", async () => {
  const p = ports();
  const invoker = new RequestOwnedToolInvoker(owner, () => {});
  await expect(
    invoker.invoke(receiptOnlyPorts(p, true), "app", "call", {
      name: "review",
      arguments: {},
    }),
  ).rejects.toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
  expect(p.receipts!.read).toHaveBeenCalledOnce();
  expect(p.receipts!.claim).not.toHaveBeenCalled();
  expect(p.receipts!.write).not.toHaveBeenCalled();
  expect(p.approve).not.toHaveBeenCalled();
  expect(p.metadata).not.toHaveBeenCalled();
  expect(p.execute).not.toHaveBeenCalled();
});
it("cannot poison the original call while it is waiting before its first receipt claim", async () => {
  const p = ports();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  p.authorize = vi.fn(async () => {
    await wait;
    return {
      owner,
      revision: "revision",
      enabled: true,
      tool: { name: "review" },
      allowedOrigins: ["app" as const],
      requiresApproval: false,
    };
  });
  const invoker = new RequestOwnedToolInvoker(owner, () => {});
  const original = invoker.invoke(
    { ...p, receipts: undefined },
    "app",
    "call",
    { name: "review", arguments: {} },
  );
  await Promise.resolve();
  await expect(
    invoker.invoke(receiptOnlyPorts(p, true), "app", "call", {
      name: "review",
      arguments: {},
    }),
  ).rejects.toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
  expect(p.receipts!.claim).not.toHaveBeenCalled();
  expect(p.receipts!.write).not.toHaveBeenCalled();
  expect(p.execute).not.toHaveBeenCalled();
  release();
  await original;
  expect(p.execute).toHaveBeenCalledOnce();
});

it.each(["direct", "request"] as const)(
  "%s missing receipt cannot poison a later original invocation",
  async (kind) => {
    const p = ports();
    const ledger = p.receipts!;
    const direct = new AuthorizedToolInvoker(owner, p);
    const request = new RequestOwnedToolInvoker(owner, () => {});
    Object.assign(p, { receiptOnly: true });
    const recover =
      kind === "direct"
        ? direct.invoke("app", "same", { name: "review", arguments: {} })
        : request.invoke(receiptOnlyPorts(p, true), "app", "same", {
            name: "review",
            arguments: {},
          });
    await expect(recover).rejects.toMatchObject({
      code: "INVOCATION_OUTCOME_UNKNOWN",
    });
    expect(ledger.claim).not.toHaveBeenCalled();
    expect(ledger.write).not.toHaveBeenCalled();
    Object.assign(p, { receiptOnly: false });
    p.receipts = undefined;
    const original =
      kind === "direct"
        ? direct.invoke("app", "same", { name: "review", arguments: {} })
        : request.invoke(p, "app", "same", { name: "review", arguments: {} });
    await expect(original).resolves.toEqual({ content: [] });
    expect(p.execute).toHaveBeenCalledOnce();
  },
);

it("a cold invoker delivers only a valid terminal durable receipt", async () => {
  const p = ports(); const params = { name: "review", arguments: { count: 0 } };
  const fingerprint = createHash("sha256").update(JSON.stringify(["app", params])).digest("hex");
  const receipt = { fingerprint, revision: "revision", expiresAt: Date.now() + 60_000,
    legs: [{ round: 0, fingerprint, state: "completed" as const, valueJson: JSON.stringify({ content: [], structuredContent: { count: 0 } }) }] };
  p.receipts!.read = vi.fn(async () => receipt);
  const cold = new RequestOwnedToolInvoker(owner, () => {});
  await expect(cold.invoke(receiptOnlyPorts(p, true), "app", "cold", params)).resolves.toEqual({ content: [], structuredContent: { count: 0 } });
  expect(p.authorize).toHaveBeenCalledTimes(2); expect(p.receipts!.claim).not.toHaveBeenCalled(); expect(p.receipts!.write).not.toHaveBeenCalled(); expect(p.execute).not.toHaveBeenCalled();
  await expect(new RequestOwnedToolInvoker(owner, () => {}).invoke(receiptOnlyPorts(p, true), "app", "cold", { name: "review", arguments: { count: 1 } })).rejects.toMatchObject({ code: "INVOCATION_ID_REUSED" });
  p.authorize = vi.fn(async () => ({ owner, revision: "changed", enabled: true, tool: { name: "review" }, allowedOrigins: ["app" as const], requiresApproval: false }));
  await expect(new RequestOwnedToolInvoker(owner, () => {}).invoke(receiptOnlyPorts(p, true), "app", "cold", params)).rejects.toMatchObject({ code: "AUTHORIZATION_CHANGED" });
});
