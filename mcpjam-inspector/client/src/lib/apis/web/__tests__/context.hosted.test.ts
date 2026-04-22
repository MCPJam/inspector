import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

import {
  setHostedApiContext,
  injectHostedServerMapping,
  normalizeHostedServerNames,
  resolveHostedServerId,
  tryGetHostedServerDisplayName,
} from "../context";

describe("injectHostedServerMapping", () => {
  beforeEach(() => {
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });
  });

  it("does not embed long opaque id refs in not-found errors", () => {
    const opaque = "mn79gdfjnftd2esny26j8n4w0s83hc8n";
    expect(() => resolveHostedServerId(opaque)).toThrow(
      "Hosted server not found. The server is not in your hosted workspace, or the server list is still loading.",
    );
  });

  it("makes a new server resolvable by name immediately", () => {
    // Before injection, the server is not found
    expect(() => resolveHostedServerId("new-server")).toThrow(
      'Hosted server not found for "new-server"',
    );

    // Inject the mapping
    injectHostedServerMapping("new-server", "id-new");

    // Now it resolves
    expect(resolveHostedServerId("new-server")).toBe("id-new");
  });

  it("preserves existing server mappings", () => {
    injectHostedServerMapping("new-server", "id-new");

    // Existing server still resolves
    expect(resolveHostedServerId("existing-server")).toBe("id-existing");
    // New server also resolves
    expect(resolveHostedServerId("new-server")).toBe("id-new");
  });

  it("is overwritten by setHostedApiContext with same data", () => {
    injectHostedServerMapping("new-server", "id-new");
    expect(resolveHostedServerId("new-server")).toBe("id-new");

    // Simulate the subscription catching up and calling setHostedApiContext
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      serverIdsByName: {
        "existing-server": "id-existing",
        "new-server": "id-new",
      },
    });

    // Still resolves after the overwrite
    expect(resolveHostedServerId("new-server")).toBe("id-new");
    expect(resolveHostedServerId("existing-server")).toBe("id-existing");
  });

  it("injected mapping is lost if setHostedApiContext fires before subscription catches up", () => {
    injectHostedServerMapping("new-server", "id-new");

    // If setHostedApiContext fires with stale data (without the new server),
    // the injected mapping is lost — this is the edge case the await prevents
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });

    expect(() => resolveHostedServerId("new-server")).toThrow(
      'Hosted server not found for "new-server"',
    );
  });

  it("normalizes hosted server ids back to stable server names", () => {
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      serverIdsByName: {
        "existing-server": "id-existing",
        "new-server": "id-new",
      },
    });

    expect(
      normalizeHostedServerNames([
        "existing-server",
        "id-existing",
        "id-new",
        "unknown-id",
      ]),
    ).toEqual(["existing-server", "new-server", "unknown-id"]);
  });

  it("resolves a display name for both server name and server id", () => {
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      serverIdsByName: {
        "my-server": "doc-id-1",
      },
    });
    expect(tryGetHostedServerDisplayName("my-server")).toBe("my-server");
    expect(tryGetHostedServerDisplayName("doc-id-1")).toBe("my-server");
    expect(tryGetHostedServerDisplayName("orphan-id")).toBeUndefined();
  });
});
