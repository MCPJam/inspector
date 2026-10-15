import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerPluginAdmissionResolver } from "../admission";
import { invokePluginRequest } from "../request-invocation";
import type { PluginInvocationPorts } from "../invocation";
vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));
vi.mock("../receipt-store.js", () => ({
  createPluginInvocationReceiptPort: () => undefined,
}));
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
function fixture(
  registered: boolean,
  rejectDelivery = false,
  revokeBeforeEffect = false,
  diagnostics?: () => unknown[],
  /** Port work after the invoker's last authorization (e.g. an inline
   * receipt write), and work handed to `defer`. */
  extra: {
    afterLast?: (ports: PluginInvocationPorts) => Promise<void>;
    deferred?: () => Promise<void>;
  } = {},
) {
  let revoked = false;
  const revalidate = vi.fn(async () => {});
  const resolve = vi.fn(async () => {
    if (revoked) throw new Error("membership revoked");
    return {
      revision: "revision",
      requiresApproval: false,
      tool: { name: "fixture" },
    };
  });
  if (registered) registerPluginAdmissionResolver(resolve);
  const release = vi.fn(async () => {});
  const effect = vi.fn();
  const app = new Hono().post("/invoke", (c) =>
    invokePluginRequest(c, {
      actor: { ...owner, subject: "subject" },
      owner,
      admission: {
        actorId: "actor",
        projectId: "project",
        workspaceId: "workspace",
        revalidate,
      },
      runtime: {
        // The tool call: the effect itself.
        manager: () =>
          ({
            executeTool: async () => {
              effect();
              return { content: [] };
            },
          }) as never,
        release,
        ...(diagnostics
          ? {
              diagnostics: diagnostics as NonNullable<
                Parameters<typeof invokePluginRequest>[1]["runtime"]["diagnostics"]
              >,
            }
          : {}),
      },
      resolve: resolve as unknown as Parameters<
        typeof invokePluginRequest
      >[1]["resolve"],
      assertLive: () => {},
      assertOrigin: () => {},
      origin: "app",
      invocationId: "operation",
      params: { name: "fixture", arguments: {} },
      invoke: async (ports, params) => {
        const signal = c.req.raw.signal;
        const authorization = await ports.authorize(
          owner,
          "app",
          params,
          signal,
        );
        await ports.admit(
          { ...authorization, origin: "app" },
          "operation",
          signal,
        );
        revoked = revokeBeforeEffect;
        const current = await ports.authorize(owner, "app", params, signal);
        const result = await ports.execute(
          { ...current, origin: "app" },
          params,
          signal,
        );
        // As the invoker does: one more authorization after the effect.
        revoked = rejectDelivery;
        await ports.authorize(owner, "app", params, signal);
        if (extra.deferred) ports.defer!(extra.deferred);
        await extra.afterLast?.(ports);
        return result;
      },
    }),
  );
  return { app, revalidate, resolve, release, effect };
}
describe("request resolver admission coalescing", () => {
  it("removes adjacent membership-only reads for the server registered resolver", async () => {
    const f = fixture(true);
    const response = await f.app.request("/invoke", { method: "POST" });
    expect(response.status).toBe(200);
    expect(f.revalidate).not.toHaveBeenCalled();
    // The route's first resolution and the invoker's three; delivery stands
    // on the invoker's last one, taken after the effect with nothing since.
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(f.effect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("keeps separate admission for arbitrary adapters with the same return shape", async () => {
    const f = fixture(false);
    expect((await f.app.request("/invoke", { method: "POST" })).status).toBe(
      200,
    );
    // Without admission in the resolver, delivery revalidates and resolves.
    expect(f.revalidate).toHaveBeenCalledTimes(2);
    expect(f.resolve).toHaveBeenCalledTimes(5);
  });
  it("reads again at delivery when any port ran after the last authorization", async () => {
    const f = fixture(true, false, false, undefined, {
      afterLast: async (ports) => {
        await ports.approve(
          {} as Parameters<PluginInvocationPorts["approve"]>[0],
          "operation",
          { name: "fixture" },
          AbortSignal.timeout(1000),
        );
      },
    });
    expect((await f.app.request("/invoke", { method: "POST" })).status).toBe(
      200,
    );
    expect(f.resolve).toHaveBeenCalledTimes(5);
  });
  it("runs deferred work once the response is decided, never gating it", async () => {
    const order: string[] = [];
    let finish!: () => void;
    const f = fixture(true, false, false, undefined, {
      deferred: async () => {
        order.push("deferred-started");
        await new Promise<void>((done) => {
          finish = done;
        });
        order.push("deferred-finished");
        throw new Error("a lost write never reaches the caller");
      },
    });
    f.release.mockImplementation(async () => {
      order.push("released");
    });
    const response = await f.app.request("/invoke", { method: "POST" });
    expect(response.status).toBe(200);
    order.push("responded");
    expect(order).toEqual(["released", "deferred-started", "responded"]);
    finish();
    await vi.waitFor(() => expect(order).toContain("deferred-finished"));
  });
  it("refuses revoked admission at the final authorization before any effect", async () => {
    const f = fixture(true, false, true);
    expect((await f.app.request("/invoke", { method: "POST" })).status).toBe(
      500,
    );
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("still refuses fresh delivery after revocation without repeating the accepted effect", async () => {
    const f = fixture(true, true);
    expect((await f.app.request("/invoke", { method: "POST" })).status).toBe(
      500,
    );
    // Refused at the invoker's authorization after the effect.
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(f.effect).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("returns the Logs entries a form step owed the client with the result", async () => {
    const entry = {
      level: "warning",
      code: "PLUGIN_FORMS_DISABLED",
      title: "Form cancelled: Forms is turned off for this client",
      description: "Forms is off.",
      serverId: "server",
    };
    const f = fixture(true, false, false, () => [entry]);
    const response = await f.app.request("/invoke", { method: "POST" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "completed",
      result: { content: [] },
      diagnostics: [entry],
    });
    // Nothing owed: the response is unchanged.
    const quiet = fixture(true, false, false, () => []);
    expect(
      await (await quiet.app.request("/invoke", { method: "POST" })).json(),
    ).toEqual({ status: "completed", result: { content: [] } });
  });
});
