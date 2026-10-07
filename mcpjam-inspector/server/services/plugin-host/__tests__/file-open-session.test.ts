import { describe, expect, it, vi } from "vitest";
import type { TrustedPluginFileResource } from "../file-resource-session.js";
import { createPluginFileOpenSession } from "../file-open-session.js";
import { managedResourceFixture } from "../testing/managed-resource-fixture.js";

function fixture() {
  let revision = "v1";
  let allowed = true;
  const resource = {
    key: "trusted-file",
    name: "model.step",
    privatePath: "/disposable/model.step",
    maxBytes: 1024,
    adapter: managedResourceFixture().adapter,
  };
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
  const resolveFile = vi.fn(async () => resource);
  const openFile = vi.fn(
    async (
      _name: string,
      _resource: TrustedPluginFileResource,
      _signal: AbortSignal,
      requireSource: () => Promise<void>,
    ) => {
      await requireSource();
    },
  );
  const listTools = vi.fn(async () => ({
    tools: [
      {
        name: "viewer",
        _meta: {
          "openai/ui": {
            entrypoints: [{ type: "file", extensions: [".step"] }],
          },
        },
      },
    ],
  }));
  const session = createPluginFileOpenSession({
    owner,
    enabled: () => allowed,
    authorize: async () => ({ revision }),
    resolveFile,
    openFile,
    listTools,
  });
  return {
    session,
    owner,
    resource,
    resolveFile,
    openFile,
    listTools,
    change: () => {
      revision = "v2";
    },
    disable: () => {
      allowed = false;
    },
  };
}

describe("opening a local file through the original authorized target", () => {
  it("resolves an explicit target and preserves the original open receipt on retry", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await f.session.open("open-1", { path: "/disposable/model.step" }, signal);
    await f.session.open("open-1", { path: "/disposable/model.step" }, signal);
    expect(f.resolveFile).toHaveBeenCalledWith(
      f.owner,
      "/disposable/model.step",
      expect.any(AbortSignal),
    );
    expect(f.openFile).toHaveBeenCalledTimes(1);
    expect(f.openFile.mock.calls[0][0]).toBe("viewer");
    f.change();
    await expect(
      f.session.open("open-1", { path: "/disposable/model.step" }, signal),
    ).rejects.toThrow("RUN_FILE_SOURCE_CHANGED");
    expect(f.openFile).toHaveBeenCalledTimes(1);
    f.session.close();
  });
  it("refuses relative paths, changed retry arguments and closed owners without another open", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f.session.open("bad", { path: "model.step" }, signal),
    ).rejects.toThrow();
    expect(f.resolveFile).not.toHaveBeenCalled();
    await f.session.open("open-1", { path: "/disposable/model.step" }, signal);
    await expect(
      f.session.open("open-1", { path: "/disposable/other.step" }, signal),
    ).rejects.toThrow("RUN_FILE_OPEN_OPERATION_REUSED");
    f.session.close();
    await expect(
      f.session.open("open-2", { path: "/disposable/model.step" }, signal),
    ).rejects.toThrow();
    expect(f.openFile).toHaveBeenCalledTimes(1);
  });
  it("refuses ambiguous viewers before activation", async () => {
    const f = fixture();
    const first = (await f.listTools()).tools[0];
    f.listTools.mockResolvedValue({
      tools: [first, { ...first, name: "other" }],
    });
    await expect(
      f.session.open(
        "ambiguous",
        { path: "/disposable/model.step" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("RUN_FILE_VIEWER_UNAVAILABLE");
    expect(f.openFile).not.toHaveBeenCalled();
    f.session.close();
  });
  it("rechecks permission after the target resolver awaits", async () => {
    const f = fixture();
    f.resolveFile.mockImplementation(async () => {
      f.disable();
      return f.resource;
    });
    await expect(
      f.session.open(
        "revoked",
        { path: "/disposable/model.step" },
        new AbortController().signal,
      ),
    ).rejects.toThrow("RUN_FILES_OPEN_UNAVAILABLE");
    expect(f.openFile).not.toHaveBeenCalled();
    f.session.close();
  });
});
