import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

import {
  setHostedApiContext,
  injectHostedServerMapping,
  resolveHostedServerId,
  _clearPendingInjections,
} from "../context";

describe("injectHostedServerMapping", () => {
  beforeEach(() => {
    _clearPendingInjections();
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });
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
      serverIdsByName: {
        "existing-server": "id-existing",
        "new-server": "id-new",
      },
    });

    // Still resolves after the overwrite
    expect(resolveHostedServerId("new-server")).toBe("id-new");
    expect(resolveHostedServerId("existing-server")).toBe("id-existing");
  });

  it("injected mapping survives setHostedApiContext with stale subscription data", () => {
    injectHostedServerMapping("new-server", "id-new");

    // Subscription fires with stale data that doesn't include the new server.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });

    // The pending injection keeps the mapping alive.
    expect(resolveHostedServerId("new-server")).toBe("id-new");
    expect(resolveHostedServerId("existing-server")).toBe("id-existing");
  });

  it("pending injection is cleaned up once subscription confirms the mapping", () => {
    injectHostedServerMapping("new-server", "id-new");

    // First update: stale, injection survives.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });
    expect(resolveHostedServerId("new-server")).toBe("id-new");

    // Second update: subscription caught up with the new server.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
        "new-server": "id-new",
      },
    });
    expect(resolveHostedServerId("new-server")).toBe("id-new");

    // Third update: server deleted from Convex — should NOT be resurrected.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });
    expect(() => resolveHostedServerId("new-server")).toThrow(
      'Hosted server not found for "new-server"',
    );
  });

  it("setHostedApiContext(null) preserves pending injections", () => {
    injectHostedServerMapping("new-server", "id-new");

    // Cleanup effect fires (e.g., component unmount).
    setHostedApiContext(null);

    // Re-mount with stale data.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });

    // Pending injection still survives.
    expect(resolveHostedServerId("new-server")).toBe("id-new");
  });

  it("multiple rapid injections all survive stale subscription data", () => {
    injectHostedServerMapping("server-a", "id-a");
    injectHostedServerMapping("server-b", "id-b");

    // Stale subscription fires without either new server.
    setHostedApiContext({
      workspaceId: "workspace-1",
      serverIdsByName: {
        "existing-server": "id-existing",
      },
    });

    expect(resolveHostedServerId("server-a")).toBe("id-a");
    expect(resolveHostedServerId("server-b")).toBe("id-b");
    expect(resolveHostedServerId("existing-server")).toBe("id-existing");
  });
});
