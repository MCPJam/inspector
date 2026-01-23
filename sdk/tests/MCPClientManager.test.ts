import { MCPClientManager } from "../src/mcp-client-manager";
import {
  startMockHttpServer,
  startMockStreamableHttpServer,
  MOCK_TOOLS,
  MOCK_RESOURCES,
  MOCK_PROMPTS,
} from "./mock-servers";

describe("MCPClientManager", () => {
  describe("constructor", () => {
    it("should create an instance with empty config", () => {
      const manager = new MCPClientManager();
      expect(manager).toBeInstanceOf(MCPClientManager);
      expect(manager.listServers()).toEqual([]);
    });

    it("should create an instance with options", () => {
      const manager = new MCPClientManager(
        {},
        {
          defaultClientName: "test-client",
          defaultClientVersion: "2.0.0",
          defaultTimeout: 5000,
        }
      );
      expect(manager).toBeInstanceOf(MCPClientManager);
    });
  });

  describe("STDIO server", () => {
    let manager: MCPClientManager;

    beforeAll(async () => {
      manager = new MCPClientManager();
      await manager.connectToServer("everything", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });
    });

    afterAll(async () => {
      await manager.disconnectAllServers();
    });

    it("should connect to server-everything via STDIO", () => {
      expect(manager.getConnectionStatus("everything")).toBe("connected");
    }, 30000);

    it("should list tools from server-everything", async () => {
      const result = await manager.listTools("everything");
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.tools.some((t) => t.name === "echo")).toBe(true);
    }, 30000);

    it("should execute the echo tool", async () => {
      const result = await manager.executeTool("everything", "echo", {
        message: "Hello, world!",
      });

      expect((result as any).content[0].text).toBe("Echo: Hello, world!");
    }, 30000);

    it("should list resources", async () => {
      const result = await manager.listResources("everything");
      expect(result.resources.length).toBeGreaterThan(0);
    }, 30000);

    it("should list prompts", async () => {
      const result = await manager.listPrompts("everything");
      expect(result.prompts.length).toBeGreaterThan(0);
    }, 30000);

    it("should disconnect from server", async () => {
      expect(manager.getConnectionStatus("everything")).toBe("connected");

      await manager.disconnectServer("everything");

      expect(manager.getConnectionStatus("everything")).toBe("disconnected");
    }, 30000);
  });

  describe("HTTP server", () => {
    let manager: MCPClientManager;
    let serverUrl: URL;
    let stopServer: () => Promise<void>;

    beforeAll(async () => {
      const result = await startMockHttpServer();
      serverUrl = result.url;
      stopServer = result.stop;
      manager = new MCPClientManager();
      await manager.connectToServer("http-server", {
        url: serverUrl,
        preferSSE: true,
      });
    });

    afterAll(async () => {
      await manager.disconnectAllServers();
      await stopServer();
    });

    it("should connect to HTTP server via SSE", async () => {
      expect(manager.getConnectionStatus("http-server")).toBe("connected");
    }, 10000);

    it("should list tools from HTTP server", async () => {
      const result = await manager.listTools("http-server");
      expect(result.tools.length).toBe(MOCK_TOOLS.length);
      expect(result.tools.map((t) => t.name)).toEqual(
        MOCK_TOOLS.map((t) => t.name)
      );
    }, 10000);

    it("should execute the echo tool via HTTP", async () => {
      const result = await manager.executeTool("http-server", "echo", {
        message: "Hello from HTTP!",
      });

      expect((result as any).content[0].text).toBe("Echo: Hello from HTTP!");
    }, 10000);

    it("should execute the add tool via HTTP", async () => {
      const result = await manager.executeTool("http-server", "add", {
        a: 10,
        b: 20,
      });

      expect((result as any).content[0].text).toBe("Result: 30");
    }, 10000);

    it("should list resources from HTTP server", async () => {
      const result = await manager.listResources("http-server");
      expect(result.resources.length).toBe(MOCK_RESOURCES.length);
    }, 10000);

    it("should read a resource from HTTP server", async () => {
      const result = await manager.readResource("http-server", {
        uri: "test://resource/1",
      });

      expect((result as any).contents[0].text).toBe(
        "This is the content of test resource 1"
      );
    }, 10000);

    it("should list prompts from HTTP server", async () => {
      const result = await manager.listPrompts("http-server");
      expect(result.prompts.length).toBe(MOCK_PROMPTS.length);
    }, 10000);

    it("should get a prompt from HTTP server", async () => {
      const result = await manager.getPrompt("http-server", {
        name: "simple_prompt",
      });

      expect((result as any).messages[0].content.text).toBe(
        "This is a simple prompt message"
      );
    }, 10000);

    it("should support accessToken in config", async () => {
      // The mock server doesn't validate tokens, but we test the config is accepted
      await manager.connectToServer("http-server-auth", {
        url: serverUrl,
        accessToken: "test-bearer-token",
        preferSSE: true,
      });

      expect(manager.getConnectionStatus("http-server-auth")).toBe("connected");
    }, 10000);
  });

  describe("HTTP server (streamable)", () => {
    let manager: MCPClientManager;
    let serverUrl: URL;
    let localhostUrl: URL;
    let stopServer: () => Promise<void>;

    beforeAll(async () => {
      const result = await startMockStreamableHttpServer();
      serverUrl = result.url;
      localhostUrl = new URL(`http://localhost:${serverUrl.port}/mcp`);
      stopServer = result.stop;
      manager = new MCPClientManager();
      await manager.connectToServer("http-localhost", {
        url: localhostUrl,
      });
    });

    afterAll(async () => {
      await manager.disconnectAllServers();
      await stopServer();
    });

    it("should connect to localhost via streamable HTTP", async () => {
      expect(manager.getConnectionStatus("http-localhost")).toBe("connected");
    }, 10000);

    it("should list tools via streamable HTTP", async () => {
      const result = await manager.listTools("http-localhost");
      expect(result.tools.length).toBe(MOCK_TOOLS.length);
    }, 10000);

    it("should execute tools via streamable HTTP", async () => {
      const result = await manager.executeTool("http-localhost", "greet", {
        name: "MCP",
      });

      expect((result as any).content[0].text).toBe("Hello, MCP!");
    }, 10000);
  });

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
        timeout: 5000,
      });

      const config = manager.getServerConfig("configured");
      expect(config).toBeDefined();
      expect((config as any).command).toBe("npx");
      expect((config as any).timeout).toBe(5000);
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

  describe("error handling", () => {
    let manager: MCPClientManager;

    beforeEach(() => {
      manager = new MCPClientManager();
    });

    afterEach(async () => {
      await manager.disconnectAllServers();
    });

    it("should throw when accessing unknown server", async () => {
      await expect(manager.listTools("unknown")).rejects.toThrow(
        'Unknown MCP server "unknown"'
      );
    });

    it("should return undefined for unknown server client", () => {
      expect(manager.getClient("unknown")).toBeUndefined();
    });

    it("should return undefined for unknown server config", () => {
      expect(manager.getServerConfig("unknown")).toBeUndefined();
    });

    it("should throw when connecting to already connected server", async () => {
      await manager.connectToServer("duplicate", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      await expect(
        manager.connectToServer("duplicate", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        })
      ).rejects.toThrow('MCP server "duplicate" is already connected');
    }, 30000);
  });

  describe("multiple servers", () => {
    let manager: MCPClientManager;
    let serverUrl: URL;
    let stopServer: () => Promise<void>;

    beforeAll(async () => {
      const result = await startMockHttpServer();
      serverUrl = result.url;
      stopServer = result.stop;
    });

    afterAll(async () => {
      await stopServer();
    });

    beforeEach(() => {
      manager = new MCPClientManager();
    });

    afterEach(async () => {
      await manager.disconnectAllServers();
    });

    it("should manage multiple servers simultaneously", async () => {
      // Connect to both STDIO and HTTP servers
      await Promise.all([
        manager.connectToServer("stdio-server", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("http-server", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      expect(manager.listServers()).toHaveLength(2);
      expect(manager.getConnectionStatus("stdio-server")).toBe("connected");
      expect(manager.getConnectionStatus("http-server")).toBe("connected");

      // Execute tools on both
      const [stdioResult, httpResult] = await Promise.all([
        manager.executeTool("stdio-server", "echo", { message: "from stdio" }),
        manager.executeTool("http-server", "echo", { message: "from http" }),
      ]);

      expect((stdioResult as any).content[0].text).toBe("Echo: from stdio");
      expect((httpResult as any).content[0].text).toBe("Echo: from http");
    }, 30000);

    it("should get tools from all servers", async () => {
      await Promise.all([
        manager.connectToServer("server-a", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("server-b", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      const result = await manager.getTools();
      // Should have tools from both servers
      expect(result.tools.length).toBeGreaterThan(MOCK_TOOLS.length);
    }, 30000);

    it("should disconnect all servers", async () => {
      await Promise.all([
        manager.connectToServer("disc-a", {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
        }),
        manager.connectToServer("disc-b", {
          url: serverUrl,
          preferSSE: true,
        }),
      ]);

      await manager.disconnectAllServers();

      expect(manager.getConnectionStatus("disc-a")).toBe("disconnected");
      expect(manager.getConnectionStatus("disc-b")).toBe("disconnected");
    }, 30000);
  });
});
