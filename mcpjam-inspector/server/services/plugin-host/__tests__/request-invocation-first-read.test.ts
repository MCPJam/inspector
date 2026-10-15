import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPluginAdmissionResolver } from "../admission";
import { invokePluginRequest } from "../request-invocation";
import type { PluginInstanceAdmissionRead } from "../instances";

const h = vi.hoisted(() => ({
  receipts: undefined as
    | undefined
    | {
        read: ReturnType<typeof vi.fn>;
        claim: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      },
}));
vi.mock("../../../utils/analytics.js", () => ({ captureServerEvent: vi.fn() }));
vi.mock("../receipt-store.js", () => ({
  createPluginInvocationReceiptPort: () => h.receipts,
}));
vi.mock("../../../utils/tool-approval-token.js", async (original) => ({
  ...(await original<typeof import("../../../utils/tool-approval-token.js")>()),
  mintToolApprovalId: () => "approval-id",
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
const firstRead: PluginInstanceAdmissionRead = async (read) => read();
const fenced: PluginInstanceAdmissionRead = async (read) => read();

/** The route's request path with a counting resolver; `invoke` plays the
 * invoker: it may touch the receipt port, then authorizes twice. */
function fixture(options: {
  firstRead?: PluginInstanceAdmissionRead;
  requiresApproval?: boolean;
  beforeFirst?: (ports: { receipts?: { read: Function } }) => Promise<void>;
  firstName?: string;
  withRead?: boolean;
}) {
  const reads: (PluginInstanceAdmissionRead | undefined)[] = [];
  const resolve = vi.fn(
    async (
      _name: string,
      _signal: AbortSignal,
      read?: PluginInstanceAdmissionRead,
    ) => {
      reads.push(read);
      return {
        revision: "revision",
        requiresApproval: options.requiresApproval === true,
        tool: { name: "fixture" },
      };
    },
  );
  registerPluginAdmissionResolver(resolve);
  const app = new Hono().post("/invoke", (c) =>
    invokePluginRequest(c, {
      actor: { ...owner, subject: "subject" },
      owner,
      admission: {
        actorId: "actor",
        projectId: "project",
        workspaceId: "workspace",
        revalidate: vi.fn(async () => {}),
      },
      runtime: { manager: () => undefined, release: vi.fn(async () => {}) },
      resolve: resolve as unknown as Parameters<
        typeof invokePluginRequest
      >[1]["resolve"],
      assertLive: () => {},
      assertOrigin: () => {},
      origin: "app",
      invocationId: "operation",
      params: { name: "fixture", arguments: {} },
      ...(options.firstRead ? { firstRead: options.firstRead } : {}),
      invoke: async (ports, params) => {
        const signal = c.req.raw.signal;
        await options.beforeFirst?.(ports as never);
        const read = options.withRead === false ? undefined : fenced;
        await ports.authorizeInstance!(
          owner,
          "app",
          { ...params, name: options.firstName ?? params.name },
          signal,
          read as PluginInstanceAdmissionRead,
        );
        await ports.authorizeInstance!(owner, "app", params, signal, fenced);
        return { content: [] };
      },
    }),
  );
  return { app, resolve, reads };
}
const post = (app: Hono) =>
  app.request("/invoke", { method: "POST", body: "{}" });

beforeEach(() => {
  h.receipts = undefined;
});
describe("the route's first resolution as the invoker's first authorization", () => {
  it("is reused once, through the fence the route resolved with", async () => {
    const f = fixture({ firstRead });
    expect((await post(f.app)).status).toBe(200);
    // Route's first resolution, then the invoker's second; delivery stands
    // on that last one (nothing ran after it).
    expect(f.reads).toEqual([firstRead, fenced]);
  });
  it("is never reused without a route fence", async () => {
    const f = fixture({});
    expect((await post(f.app)).status).toBe(200);
    expect(f.reads).toEqual([undefined, fenced, fenced]);
  });
  it.each([
    ["for another tool", { firstName: "other" }],
    ["by an authorization without fenced reads", { withRead: false }],
  ])("is not reused %s", async (_case, extra) => {
    const f = fixture({ firstRead, ...extra });
    expect((await post(f.app)).status).toBe(200);
    expect(f.resolve).toHaveBeenCalledTimes(3);
  });
  it("is dropped by any receipt work before the first authorization", async () => {
    h.receipts = {
      read: vi.fn(async () => null),
      claim: vi.fn(),
      write: vi.fn(),
    };
    const f = fixture({
      firstRead,
      beforeFirst: async (ports) => {
        await ports.receipts!.read("operation", AbortSignal.timeout(1000));
      },
    });
    expect((await post(f.app)).status).toBe(200);
    expect(h.receipts.read).toHaveBeenCalledOnce();
    expect(f.reads).toEqual([firstRead, fenced, fenced]);
  });
  it("is dropped after the approval check reads a saved receipt", async () => {
    h.receipts = {
      read: vi.fn(async () => ({ legs: [] })),
      claim: vi.fn(),
      write: vi.fn(),
    };
    const f = fixture({ firstRead, requiresApproval: true });
    expect((await post(f.app)).status).toBe(200);
    expect(h.receipts.read).toHaveBeenCalledOnce();
    expect(f.reads).toEqual([firstRead, fenced, fenced]);
  });
});
