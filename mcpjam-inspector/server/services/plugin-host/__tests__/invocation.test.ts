import { describe, expect, it, vi } from "vitest";
import { buildToolPolicySnapshot } from "@mcpjam/sdk/contract";
import { ResourceGrantService } from "../resource-grants.js";
import { RequestOwnedToolInvoker } from "../request-invoker.js";
import {
  AuthorizedToolInvoker,
  createPluginAdmissionNoop,
  PLUGIN_INVOCATION_ORIGINS,
  type AuthorizedInvocation,
  type PluginInvocationPorts,
  type TrustedInvocationOwner,
} from "../invocation.js";

const owner: TrustedInvocationOwner = {
  actorId: "fixture-actor",
  projectId: "fixture-project",
  workspaceId: "fixture-workspace",
  instanceId: "fixture-instance",
  generation: 1,
  serverId: "fixture-server",
  bindingId: "fixture-binding",
  placement: "ephemeral-run",
  runId: "fixture-run",
};
function fixture(overrides: Partial<AuthorizedInvocation> = {}) {
  let authorization: AuthorizedInvocation = {
    revision: "revision-1",
    owner,
    enabled: true,
    tool: { name: "synthetic" },
    allowedOrigins: PLUGIN_INVOCATION_ORIGINS,
    requiresApproval: false,
    ...overrides,
  };
  const result = {
    content: [{ type: "text", text: "fixture" }],
    structuredContent: { complete: true },
    _meta: { "fixture/result": { full: true } },
  };
  const ports: PluginInvocationPorts & {
    metadata: NonNullable<PluginInvocationPorts["metadata"]>;
  } = {
    authorize: vi.fn(async () => authorization),
    approve: vi.fn(async () => true),
    admit: vi.fn(async () => {}),
    metadata: vi.fn(async () => ({})),
    execute: vi.fn(async () => result),
    classifyFailure: vi.fn((): "unknown" => "unknown"),
  };
  return {
    ports,
    result,
    invoker: new AuthorizedToolInvoker(owner, ports),
    set: (next: Partial<AuthorizedInvocation>) => {
      authorization = { ...authorization, ...next };
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("authorized plugin invocation boundary", () => {
  it("preserves effect-free admission through the actual request-owned adapter", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    const invoker = new RequestOwnedToolInvoker(owner, () => {});
    await invoker.invoke(
      { ...ports, admit: createPluginAdmissionNoop() },
      "app",
      "request-no-admission",
      { name: "synthetic" },
    );
    expect(ports.authorize).toHaveBeenCalledTimes(2);
    expect(ports.execute).toHaveBeenCalledOnce();
    vi.mocked(ports.authorize).mockClear();
    await invoker.invoke(ports, "app", "request-real-admission", {
      name: "synthetic",
    });
    expect(ports.authorize).toHaveBeenCalledTimes(3);
    expect(ports.admit).toHaveBeenCalledOnce();
  });
  it("omits only the factory's effect-free admission round trip", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    const invoker = new AuthorizedToolInvoker(owner, {
      ...ports,
      admit: createPluginAdmissionNoop(),
    });
    await invoker.invoke("app", "no-admission-work", { name: "synthetic" });
    expect(ports.authorize).toHaveBeenCalledTimes(2);
    expect(ports.execute).toHaveBeenCalledOnce();
    expect(ports.admit).not.toHaveBeenCalled();
  });
  it("keeps the fence for arbitrary admission callbacks, including async no-ops", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    await new AuthorizedToolInvoker(owner, ports).invoke(
      "app",
      "ordinary-admission",
      { name: "synthetic" },
    );
    expect(ports.authorize).toHaveBeenCalledTimes(3);
    expect(ports.admit).toHaveBeenCalledOnce();
  });
  it("still fences revocation during metadata after effect-free admission", async () => {
    const f = fixture();
    f.ports.metadata = vi.fn(async () => {
      f.set({ enabled: false });
      return {};
    });
    const invoker = new AuthorizedToolInvoker(owner, {
      ...f.ports,
      admit: createPluginAdmissionNoop(),
    });
    await expect(
      invoker.invoke("app", "metadata-revoked", { name: "synthetic" }),
    ).rejects.toThrow();
    expect(f.ports.execute).not.toHaveBeenCalled();
  });
  it("uses no fabricated metadata service and still strips caller-supplied resource authority", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    const invoker = new AuthorizedToolInvoker(owner, ports);
    await invoker.invoke("app", "no-metadata", {
      name: "synthetic",
      _meta: {
        "openai/resource.path": "/forged",
        "mcpjam/actorId": "foreign",
        "fixture/custom": "preserved",
      },
    });
    expect(f.ports.metadata).not.toHaveBeenCalled();
    expect(vi.mocked(f.ports.execute).mock.calls[0][1]._meta).toEqual({
      "fixture/custom": "preserved",
    });
  });
  it("fences admission revocation before effects even without a metadata service", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    vi.mocked(f.ports.admit).mockImplementation(async () => {
      f.set({ enabled: false });
    });
    await expect(
      new AuthorizedToolInvoker(owner, ports).invoke(
        "app",
        "no-metadata-revoked",
        { name: "synthetic" },
      ),
    ).rejects.toThrow();
    expect(f.ports.execute).not.toHaveBeenCalled();
  });
  it("retains unknown outcomes after a wire effect if authority changes without a metadata service", async () => {
    const f = fixture();
    const { metadata: _unused, ...ports } = f.ports;
    vi.mocked(f.ports.execute).mockImplementation(async () => {
      f.set({ enabled: false });
      return f.result;
    });
    await expect(
      new AuthorizedToolInvoker(owner, ports).invoke(
        "app",
        "no-metadata-unknown",
        { name: "synthetic" },
      ),
    ).rejects.toMatchObject({ code: "INVOCATION_OUTCOME_UNKNOWN" });
    expect(f.ports.execute).toHaveBeenCalledOnce();
  });
  it("emits one bounded receipt observation and isolates observer failure from effects", async () => {
    const f = fixture();
    const observe = vi.fn(() => {
      throw new Error("observer failed");
    });
    const invoker = new AuthorizedToolInvoker(owner, f.ports, 2048, observe);
    const request = { name: "synthetic" };
    const result = await Promise.all([
      invoker.invoke("app", "once", request),
      invoker.invoke("app", "once", request),
    ]);
    expect(result).toEqual([f.result, f.result]);
    expect(observe.mock.calls).toEqual([
      ["once", "call-started", "app"],
      ["once", "call-completed", "app"],
    ]);
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
    await expect(
      invoker.invoke("app", "once", { name: "changed" }),
    ).rejects.toThrow("ID_REUSED");
    expect(observe).toHaveBeenCalledTimes(2);
  });
  it.each(PLUGIN_INVOCATION_ORIGINS)(
    "enforces the existing policy snapshot for %s",
    async (origin) => {
      const f = fixture({
        toolPolicy: buildToolPolicySnapshot({
          policy: { mode: "default", deny: ["synthetic"] },
          tools: [{ name: "synthetic" }],
        }),
      });
      await expect(
        f.invoker.invoke(origin, "denied", { name: "synthetic" }),
      ).rejects.toMatchObject({ code: "TOOL_POLICY_DENIED" });
      expect(f.ports.approve).not.toHaveBeenCalled();
      expect(f.ports.admit).not.toHaveBeenCalled();
      expect(f.ports.execute).not.toHaveBeenCalled();
    },
  );

  it("deduplicates concurrent delivery and preserves complete supported params/results", async () => {
    const f = fixture();
    const params = {
      name: "synthetic",
      arguments: { one: [1, 2] },
      _meta: { "fixture/unknown": { nested: true } },
      additionalFixtureParam: "preserved",
    };
    const first = f.invoker.invoke("app", "same", params);
    const second = f.invoker.invoke("app", "same", structuredClone(params));
    // One accepted effect, with an independently authorized delivery per caller.
    expect(await Promise.all([first, second])).toEqual([f.result, f.result]);
    expect(f.ports.admit).toHaveBeenCalledTimes(1);
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.ports.execute).mock.calls[0][1]).toEqual(params);
    expect(vi.mocked(f.ports.execute).mock.calls[0][0].origin).toBe("app");
    await expect(
      f.invoker.invoke("app", "same", {
        name: "synthetic",
        arguments: { changed: true },
      }),
    ).rejects.toMatchObject({ code: "INVOCATION_ID_REUSED" });
  });

  it("derives reserved metadata from trusted grants and keeps unknown metadata", async () => {
    const f = fixture();
    vi.mocked(f.ports.metadata).mockResolvedValue({
      "openai/resource.path": "/disposable-fixture/owned",
      "mcpjam/invocationId": "trusted-id",
    });
    await f.invoker.invoke("app", "metadata", {
      name: "synthetic",
      _meta: {
        "openai/resource.path": "/foreign",
        "mcpjam/actorId": "other",
        _serverId: "other",
        "io.modelcontextprotocol/clientCapabilities": { forged: true },
        traceparent: "forged",
        "fixture/custom": { intact: true },
      },
    });
    expect(vi.mocked(f.ports.execute).mock.calls[0][1]._meta).toEqual({
      "fixture/custom": { intact: true },
      "openai/resource.path": "/disposable-fixture/owned",
      "mcpjam/invocationId": "trusted-id",
    });
    expect(vi.mocked(f.ports.authorize).mock.calls[0][0]).toEqual(owner);
    expect(vi.mocked(f.ports.authorize).mock.calls[0][2]._meta).toEqual({
      "fixture/custom": { intact: true },
    });
  });

  it.each(PLUGIN_INVOCATION_ORIGINS)(
    "strips nested and flat resource path authority for %s before policy and dispatch",
    async (origin) => {
      const f = fixture();
      if (origin === "mention")
        f.set({
          tool: {
            name: "synthetic",
            _meta: {
              "openai/extensions": { "mentions/search": {} },
              ui: { visibility: ["app"] },
            },
          },
        });
      const params = {
        name: "synthetic",
        _meta: {
          "openai/resource.path": "/fixture/flat-forgery",
          "openai/resource": {
            path: "/fixture/nested-forgery",
            custom: { intact: true },
          },
          "fixture/custom": { intact: true },
        },
      };
      await f.invoker.invoke(origin, "path-forgery", params);
      const expected = {
        "openai/resource": { custom: { intact: true } },
        "fixture/custom": { intact: true },
      };
      expect(vi.mocked(f.ports.authorize).mock.calls[0][2]._meta).toEqual(
        expected,
      );
      expect(vi.mocked(f.ports.execute).mock.calls[0][1]._meta).toEqual(
        expected,
      );
      expect(params._meta["openai/resource"].path).toBe(
        "/fixture/nested-forgery",
      );
    },
  );

  it("dispatches the specified nested path from the bound resource grant while retaining other metadata", async () => {
    const f = fixture();
    const resourceOwner = {
      actorId: owner.actorId,
      projectId: owner.projectId,
      subject: "verified-subject",
      workspaceId: owner.workspaceId,
      instanceId: owner.instanceId,
      generation: owner.generation,
      serverId: owner.serverId,
      bindingId: owner.bindingId,
    };
    const grants = new ResourceGrantService({
      authorize: async () => {},
      maxBytes: 20,
    });
    const read = vi.fn();
    const { resourceUri } = grants.open(resourceOwner, {
      key: "private-fixture-key",
      adapter: { read },
      privatePath: "/disposable-fixture/owned.txt",
    });
    vi.mocked(f.ports.metadata).mockImplementation(
      async (_authorization, params) =>
        grants.toolMetadata(resourceOwner, resourceUri, params._meta),
    );
    await f.invoker.invoke("app", "owned-path", {
      name: "synthetic",
      _meta: {
        "openai/resource.path": "/fixture/flat-forgery",
        "openai/resource": {
          path: "/fixture/nested-forgery",
          custom: { intact: true },
        },
      },
    });
    expect(vi.mocked(f.ports.execute).mock.calls[0][1]._meta).toEqual({
      "openai/resource": {
        path: "/disposable-fixture/owned.txt",
        custom: { intact: true },
      },
    });
    expect(read).not.toHaveBeenCalled();
    grants.dispose();
  });

  it.each([
    "actorId",
    "projectId",
    "workspaceId",
    "instanceId",
    "serverId",
    "bindingId",
    "placement",
    "runId",
    "generation",
  ] as const)("rejects a changed trusted %s", async (key) => {
    const f = fixture({
      owner: {
        ...owner,
        [key]: key === "generation" ? 2 : "foreign",
      } as TrustedInvocationOwner,
    });
    await expect(
      f.invoker.invoke("app", "foreign", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "INVOCATION_DENIED" });
    expect(f.ports.execute).not.toHaveBeenCalled();
  });

  it("requires the declared target and origin; direct entrypoints bypass only visibility", async () => {
    const f = fixture({
      tool: { name: "synthetic", _meta: { ui: { visibility: ["model"] } } },
    });
    await expect(
      f.invoker.invoke("app", "app", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "TOOL_VISIBILITY_DENIED" });
    await expect(
      f.invoker.invoke("entrypoint", "entrypoint", { name: "synthetic" }),
    ).resolves.toEqual(f.result);
    await expect(
      f.invoker.invoke("entrypoint", "cross", { name: "foreign:synthetic" }),
    ).rejects.toMatchObject({ code: "INVOCATION_DENIED" });
    f.set({ allowedOrigins: ["model"] });
    await expect(
      f.invoker.invoke("settings", "settings", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "INVOCATION_DENIED" });
  });

  it("revalidates after approval and refuses a changed revision before dispatch", async () => {
    const f = fixture({ requiresApproval: true });
    vi.mocked(f.ports.approve).mockImplementation(async () => {
      f.set({ revision: "revision-2" });
      return true;
    });
    await expect(
      f.invoker.invoke("app", "approval", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_CHANGED" });
    expect(f.ports.admit).not.toHaveBeenCalled();
    expect(f.ports.execute).not.toHaveBeenCalled();
  });

  it("rechecks flags after metadata resolution and fails closed when authority is unavailable", async () => {
    const f = fixture();
    vi.mocked(f.ports.metadata).mockImplementation(async () => {
      f.set({ enabled: false });
      return {};
    });
    await expect(
      f.invoker.invoke("app", "disabled", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "INVOCATION_DENIED" });
    expect(f.ports.execute).not.toHaveBeenCalled();
    const unavailable = fixture();
    vi.mocked(unavailable.ports.authorize).mockRejectedValue(
      new Error("Fixture authority unavailable"),
    );
    await expect(
      unavailable.invoker.invoke("app", "unavailable", { name: "synthetic" }),
    ).rejects.toThrow("unavailable");
    expect(unavailable.ports.admit).not.toHaveBeenCalled();
  });

  it("cancels a queued approval without waiting for a late adapter", async () => {
    const f = fixture({ requiresApproval: true });
    const waiting = deferred<boolean>();
    const entered = deferred<void>();
    vi.mocked(f.ports.approve).mockImplementation(() => {
      entered.resolve();
      return waiting.promise;
    });
    const result = f.invoker.invoke("app", "close", { name: "synthetic" });
    await entered.promise;
    f.invoker.close();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    waiting.resolve(true);
    await Promise.resolve();
    expect(f.ports.execute).not.toHaveBeenCalled();
  });

  it("records an uncertain dispatched outcome and never repeats it on delivery retry", async () => {
    const f = fixture();
    const started = deferred<void>();
    const waiting = deferred<unknown>();
    vi.mocked(f.ports.execute).mockImplementation(() => {
      started.resolve();
      return waiting.promise;
    });
    const abort = new AbortController();
    const result = f.invoker.invoke(
      "app",
      "lost",
      { name: "synthetic" },
      abort.signal,
    );
    await started.promise;
    abort.abort();
    await expect(result).rejects.toMatchObject({
      code: "INVOCATION_OUTCOME_UNKNOWN",
      outcomeUnknown: true,
    });
    waiting.resolve(f.result);
    await expect(
      f.invoker.invoke("app", "lost", { name: "synthetic" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });

  it("discards results after revocation and preserves authoritative known failures", async () => {
    const revoked = fixture();
    vi.mocked(revoked.ports.execute).mockImplementation(async () => {
      revoked.set({ enabled: false });
      return revoked.result;
    });
    await expect(
      revoked.invoker.invoke("app", "revoked", { name: "synthetic" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    const known = fixture();
    const error = new Error("Fixture server rejected call");
    vi.mocked(known.ports.execute).mockRejectedValue(error);
    vi.mocked(known.ports.classifyFailure).mockReturnValue("failed");
    await expect(
      known.invoker.invoke("model", "known", { name: "synthetic" }),
    ).rejects.toBe(error);
  });

  it.each(
    PLUGIN_INVOCATION_ORIGINS.flatMap((origin) =>
      (["enabled", "revision", "policy", "origin"] as const).map(
        (mutation) => ({ origin, mutation }),
      ),
    ),
  )(
    "refuses cached $origin data after fresh $mutation revocation without repeating effects",
    async ({ origin, mutation }) => {
      const tool = {
        name: "synthetic",
        _meta: {
          ui: { visibility: ["model", "app"] },
          "openai/extensions": { "mentions/search": {} },
        },
      };
      const f = fixture({ tool, requiresApproval: true });
      await expect(
        f.invoker.invoke(origin, "receipt", { name: "synthetic" }),
      ).resolves.toEqual(f.result);
      const next =
        mutation === "enabled"
          ? { enabled: false }
          : mutation === "revision"
            ? { revision: "revision-2" }
            : mutation === "origin"
              ? { allowedOrigins: [] }
              : {
                  toolPolicy: buildToolPolicySnapshot({
                    policy: { mode: "default", deny: ["synthetic"] },
                    tools: [tool],
                  }),
                };
      f.set(next);
      await expect(
        f.invoker.invoke(origin, "receipt", { name: "synthetic" }),
      ).rejects.toMatchObject({
        code:
          mutation === "revision"
            ? "AUTHORIZATION_CHANGED"
            : mutation === "policy"
              ? "TOOL_POLICY_DENIED"
              : "INVOCATION_DENIED",
      });
      for (const port of [
        f.ports.approve,
        f.ports.admit,
        f.ports.metadata,
        f.ports.execute,
      ])
        expect(port).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["app", "model"] as const)(
    "rechecks cached %s tool visibility",
    async (origin) => {
      const f = fixture();
      await f.invoker.invoke(origin, "visibility", { name: "synthetic" });
      f.set({
        tool: {
          name: "synthetic",
          _meta: { ui: { visibility: [origin === "app" ? "model" : "app"] } },
        },
      });
      await expect(
        f.invoker.invoke(origin, "visibility", { name: "synthetic" }),
      ).rejects.toThrow("TOOL_VISIBILITY_DENIED");
      expect(f.ports.execute).toHaveBeenCalledTimes(1);
    },
  );
  it("refuses a cached mention after its declaration disappears", async () => {
    const f = fixture({
      tool: {
        name: "synthetic",
        _meta: {
          ui: { visibility: ["app"] },
          "openai/extensions": { "mentions/search": {} },
        },
      },
    });
    await f.invoker.invoke("mention", "mention", { name: "synthetic" });
    f.set({ tool: { name: "synthetic" } });
    await expect(
      f.invoker.invoke("mention", "mention", { name: "synthetic" }),
    ).rejects.toThrow("TOOL_MENTION_DECLARATION_DENIED");
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });
  it("checks complete owner identity and authority availability before delivering a cached result", async () => {
    const f = fixture();
    await f.invoker.invoke("app", "owner", { name: "synthetic" });
    f.set({ owner: { ...owner, generation: 2 } });
    await expect(
      f.invoker.invoke("app", "owner", { name: "synthetic" }),
    ).rejects.toThrow("INVOCATION_DENIED");
    f.set({ owner });
    vi.mocked(f.ports.authorize).mockRejectedValue(
      new Error("Fixture authority unavailable"),
    );
    await expect(
      f.invoker.invoke("app", "owner", { name: "synthetic" }),
    ).rejects.toThrow("authority unavailable");
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });
  it("aborts only a duplicate delivery wait while the original effect still completes", async () => {
    const f = fixture({ requiresApproval: true });
    const started = deferred<void>();
    const waiting = deferred<unknown>();
    vi.mocked(f.ports.execute).mockImplementation(() => {
      started.resolve();
      return waiting.promise;
    });
    const first = f.invoker.invoke("app", "wait", { name: "synthetic" });
    await started.promise;
    const abort = new AbortController();
    const duplicate = f.invoker.invoke(
      "app",
      "wait",
      { name: "synthetic" },
      abort.signal,
    );
    const refused = expect(duplicate).rejects.toMatchObject({
      name: "AbortError",
    });
    abort.abort();
    await refused;
    expect(vi.mocked(f.ports.execute).mock.calls[0][2].aborted).toBe(false);
    waiting.resolve(f.result);
    expect(await first).toEqual(f.result);
    expect(
      await f.invoker.invoke("app", "wait", { name: "synthetic" }),
    ).toEqual(f.result);
    expect(f.ports.approve).toHaveBeenCalledTimes(1);
    expect(f.ports.admit).toHaveBeenCalledTimes(1);
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });
  it("observes a cached delivery's late owner close even when authorization ignores abort", async () => {
    const f = fixture();
    await f.invoker.invoke("app", "close-replay", { name: "synthetic" });
    const entered = deferred<void>();
    const authorization = deferred<AuthorizedInvocation>();
    vi.mocked(f.ports.authorize).mockImplementation(() => {
      entered.resolve();
      return authorization.promise;
    });
    const duplicate = f.invoker.invoke("app", "close-replay", {
      name: "synthetic",
    });
    const refused = expect(duplicate).rejects.toMatchObject({
      name: "AbortError",
    });
    await entered.promise;
    f.invoker.close();
    await refused;
    authorization.resolve({
      owner,
      revision: "revision-1",
      enabled: true,
      tool: { name: "synthetic" },
      allowedOrigins: ["app"],
      requiresApproval: false,
    });
    expect(f.ports.execute).toHaveBeenCalledTimes(1);
  });
  it("revalidates both success and known error delivery after the cached outcome wait", async () => {
    for (const kind of ["result", "error"] as const) {
      const f = fixture();
      const error = new Error("Fixture server rejected call");
      if (kind === "error") {
        vi.mocked(f.ports.execute).mockRejectedValue(error);
        vi.mocked(f.ports.classifyFailure).mockReturnValue("failed");
        await expect(
          f.invoker.invoke("app", "after", { name: "synthetic" }),
        ).rejects.toBe(error);
      } else await f.invoker.invoke("app", "after", { name: "synthetic" });
      vi.mocked(f.ports.authorize)
        .mockResolvedValueOnce({
          owner,
          revision: "revision-1",
          enabled: true,
          tool: { name: "synthetic" },
          allowedOrigins: ["app"],
          requiresApproval: false,
        })
        .mockImplementation(async () => ({
          owner,
          revision: "revision-2",
          enabled: true,
          tool: { name: "synthetic" },
          allowedOrigins: ["app"],
          requiresApproval: false,
        }));
      await expect(
        f.invoker.invoke("app", "after", { name: "synthetic" }),
      ).rejects.toThrow("AUTHORIZATION_CHANGED");
      expect(f.ports.execute).toHaveBeenCalledTimes(1);
    }
  });
});
