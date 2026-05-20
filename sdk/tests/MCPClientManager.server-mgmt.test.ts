import { MCPClientManager } from "../src/mcp-client-manager";

describe("MCPClientManager", () => {
  describe("server management", () => {
    let manager: MCPClientManager;

    beforeEach(() => {
      manager = new MCPClientManager();
    });

    afterEach(async () => {
      await manager.disconnectAllServers();
    });

    it("should list registered servers", async () => {
      await manager.connectToServer("server1", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const servers = manager.listServers();
      expect(servers).toContain("server1");
    }, 30000);

    it("should check if server exists", async () => {
      await manager.connectToServer("myserver", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      expect(manager.hasServer("myserver")).toBe(true);
      expect(manager.hasServer("nonexistent")).toBe(false);
    }, 30000);

    it("should get server config", async () => {
      await manager.connectToServer("configured", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        timeout: 30000,
      });

      const config = manager.getServerConfig("configured");
      expect(config).toBeDefined();
      expect((config as any).command).toBe("npx");
      expect((config as any).timeout).toBe(30000);
    }, 30000);

    it("should get server summaries", async () => {
      await manager.connectToServer("summary-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const summaries = manager.getServerSummaries();
      expect(summaries.length).toBe(1);
      expect(summaries[0].id).toBe("summary-test");
      expect(summaries[0].status).toBe("connected");
    }, 30000);

    it("should get server capabilities", async () => {
      await manager.connectToServer("caps-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const capabilities = manager.getServerCapabilities("caps-test");
      expect(capabilities).toBeDefined();
      expect(capabilities?.tools).toBeDefined();
    }, 30000);

    it("should advertise MCP Apps UI extension by default", async () => {
      await manager.connectToServer("extensions-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const info = manager.getInitializationInfo("extensions-test");
      expect(info).toBeDefined();

      const extensions = (info!.clientCapabilities as Record<string, unknown>)
        .extensions as Record<string, unknown>;
      expect(extensions["io.modelcontextprotocol/ui"]).toEqual({
        mimeTypes: ["text/html;profile=mcp-app"],
      });

      await manager.disconnectServer("extensions-test");
    }, 30000);

    it("should merge legacy per-server capabilities on top of default UI capabilities", async () => {
      await manager.connectToServer("legacy-caps-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        capabilities: {
          experimental: {
            inspectorProfile: {},
          },
        } as any,
      });

      const info = manager.getInitializationInfo("legacy-caps-test");
      expect(info).toBeDefined();
      expect(info!.clientCapabilities).toMatchObject({
        experimental: {
          inspectorProfile: {},
        },
      });
      expect(info!.clientCapabilities).not.toHaveProperty("elicitation");

      const extensions = (info!.clientCapabilities as Record<string, unknown>)
        .extensions as Record<string, unknown>;
      expect(extensions["io.modelcontextprotocol/ui"]).toEqual({
        mimeTypes: ["text/html;profile=mcp-app"],
      });

      await manager.disconnectServer("legacy-caps-test");
    }, 30000);

    it("should merge manager defaultCapabilities with legacy per-server capabilities", async () => {
      const managerWithDefaults = new MCPClientManager(
        {},
        {
          defaultCapabilities: {
            sampling: {},
          } as any,
        }
      );

      try {
        await managerWithDefaults.connectToServer("manager-default-caps-test", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          capabilities: {
            experimental: {
              inspectorProfile: {},
            },
          } as any,
        });

        const info = managerWithDefaults.getInitializationInfo(
          "manager-default-caps-test"
        );
        expect(info).toBeDefined();
        expect(info!.clientCapabilities).toMatchObject({
          sampling: {},
          experimental: {
            inspectorProfile: {},
          },
        });
        expect(info!.clientCapabilities).not.toHaveProperty("elicitation");
        expect(
          (
            (info!.clientCapabilities as Record<string, unknown>).extensions as
              | Record<string, unknown>
              | undefined
          )?.["io.modelcontextprotocol/ui"]
        ).toEqual({
          mimeTypes: ["text/html;profile=mcp-app"],
        });
      } finally {
        await managerWithDefaults.disconnectAllServers();
      }
    }, 30000);

    it("should let per-server clientCapabilities bypass defaults and legacy merge", async () => {
      await manager.connectToServer("custom-caps-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        capabilities: {
          experimental: {
            legacyPath: {},
          },
        } as any,
        clientCapabilities: {
          experimental: {
            exactPath: {},
          },
        } as any,
      });

      const info = manager.getInitializationInfo("custom-caps-test");
      expect(info).toBeDefined();
      expect(info!.clientCapabilities).toMatchObject({
        experimental: {
          exactPath: {},
        },
      });
      expect(info!.clientCapabilities).not.toHaveProperty("elicitation");
      expect(info!.clientCapabilities).not.toMatchObject({
        experimental: {
          legacyPath: {},
        },
      });
      expect(
        (
          (info!.clientCapabilities as Record<string, unknown>).extensions as
            | Record<string, unknown>
            | undefined
        )?.["io.modelcontextprotocol/ui"]
      ).toBeUndefined();

      await manager.disconnectServer("custom-caps-test");
    }, 30000);

    it("should advertise elicitation when a global callback is registered before connect", async () => {
      manager.setElicitationCallback(() => ({ action: "cancel" } as any));

      await manager.connectToServer("elicitation-enabled-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const info = manager.getInitializationInfo("elicitation-enabled-test");
      expect(info).toBeDefined();
      expect(info!.clientCapabilities).toMatchObject({
        elicitation: {},
      });

      await manager.disconnectServer("elicitation-enabled-test");
    }, 30000);

    it("should keep exact clientCapabilities free of elicitation when not explicitly configured", async () => {
      manager.setElicitationCallback(() => ({ action: "cancel" } as any));

      await manager.connectToServer("exact-caps-no-elicitation-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        clientCapabilities: {
          experimental: {
            exactPath: {},
          },
        } as any,
      });

      const info = manager.getInitializationInfo(
        "exact-caps-no-elicitation-test"
      );
      expect(info).toBeDefined();
      expect(info!.clientCapabilities).toMatchObject({
        experimental: {
          exactPath: {},
        },
      });
      expect(info!.clientCapabilities).not.toHaveProperty("elicitation");

      await manager.disconnectServer("exact-caps-no-elicitation-test");
    }, 30000);

    it("should preserve the initialize payload after elicitation is enabled post-connect", async () => {
      await manager.connectToServer("late-elicitation-test", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const before = manager.getInitializationInfo("late-elicitation-test");
      expect(before).toBeDefined();
      expect(before!.clientCapabilities).not.toHaveProperty("elicitation");

      expect(() =>
        manager.setElicitationCallback(() => ({ action: "cancel" } as any))
      ).not.toThrow();

      const after = manager.getInitializationInfo("late-elicitation-test");
      expect(after).toBeDefined();
      expect(after!.clientCapabilities).not.toHaveProperty("elicitation");

      await manager.disconnectServer("late-elicitation-test");
    }, 30000);

    it("should remove server", async () => {
      await manager.connectToServer("to-remove", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      expect(manager.hasServer("to-remove")).toBe(true);

      await manager.removeServer("to-remove");

      expect(manager.hasServer("to-remove")).toBe(false);
    }, 30000);
  });
});
