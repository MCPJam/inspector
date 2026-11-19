import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../utils/logger.js";
import { ModelFormRegistry } from "../model-form-control.js";

const identity = {
  actorId: "actor",
  projectId: "project",
  workspaceId: "workspace",
  subject: "subject",
};
const instance = {
  owner: {
    actorId: "actor",
    projectId: "project",
    workspaceId: "workspace",
    instanceId: "instance",
    generation: 1,
    serverId: "server",
    bindingId: "binding",
    placement: "interactive" as const,
  },
  subject: identity.subject,
  hostId: "host",
  hostRevision: "host-v1",
  serverIdentity: { kind: "standalone" as const, serverId: "server" },
};
const signal = () => AbortSignal.timeout(5000);

afterEach(() => vi.restoreAllMocks());

/** A suspended model call whose tool input is `kib` KiB. */
function suspended(registry: ModelFormRegistry, kib: number) {
  return registry.begin({
    instance,
    identity,
    params: {
      name: "cad.reviewForm",
      arguments: { drawing: "x".repeat(kib * 1024) },
    },
    toolCallId: `call-${kib}`,
    revision: "tool-v1",
  });
}

describe("storing a suspended model form", () => {
  it("refuses a form over the backend's limit on hosted, logs its size and writes nothing", async () => {
    const issue = vi.fn(async () => ({}));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const hosted = new ModelFormRegistry(
      undefined,
      undefined,
      () => ({ issue }) as never,
      () => true,
    );
    const form = suspended(hosted, 130);
    await expect(hosted.store(form, signal())).rejects.toMatchObject({
      code: "FORM_NOT_SAVED",
    });
    expect(issue).not.toHaveBeenCalled();
    expect(form.stored).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "Model form not shown: its record is too large to store",
      { bytes: expect.any(Number) },
    );
    expect(warn.mock.calls[0]![1]!.bytes).toBeGreaterThan(130 * 1024);
    form.release();
  });

  it("stores the same form on a local install, where it works today", async () => {
    const issue = vi.fn(async () => ({}));
    const local = new ModelFormRegistry(
      undefined,
      undefined,
      () => ({ issue }) as never,
      () => false,
    );
    const form = suspended(local, 130);
    await local.store(form, signal());
    expect(issue).toHaveBeenCalledOnce();
    expect(form.stored).toBe(true);
    form.release();
  });

  it("refuses a form the store won't take, and logs why", async () => {
    const { PluginInvocationError } = await import("../invocation.js");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const registry = new ModelFormRegistry(
      undefined,
      undefined,
      () =>
        ({
          issue: async () => {
            throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
          },
        }) as never,
      () => true,
    );
    const form = suspended(registry, 1);
    await expect(registry.store(form, signal())).rejects.toMatchObject({
      code: "FORM_NOT_SAVED",
    });
    expect(warn).toHaveBeenCalledWith(
      "Model form not shown: its record was not stored",
      { code: "INSTANCE_STORE_UNAVAILABLE" },
    );
    form.release();
  });
});
