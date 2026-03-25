import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

import {
  buildHostedServerRequest,
  setHostedApiContext,
  injectHostedServerMapping,
  resolveHostedServerId,
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

  it("uses explicit runtime server configs before workspace server-id resolution", () => {
    setHostedApiContext({
      workspaceId: "workspace-1",
      isAuthenticated: true,
      clientCapabilities: { roots: {} },
      serverIdsByName: {
        "existing-server": "id-existing",
      },
      runtimeServerConfigs: {
        __learning__: {
          url: "https://learn.mcpjam.com/mcp",
          requestInit: {
            headers: {
              "x-learning-mode": "true",
            },
          },
        },
      },
    });

    expect(buildHostedServerRequest("__learning__")).toEqual({
      serverUrl: "https://learn.mcpjam.com/mcp",
      serverHeaders: {
        "x-learning-mode": "true",
      },
      clientCapabilities: { roots: {} },
    });
  });
});
