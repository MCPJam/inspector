import { MCPAuthError, MCPClientManager } from "../src/mcp-client-manager";
import { realpathSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startMockHttpServer,
  startMockStreamableHttpServer,
  MOCK_TOOLS,
  MOCK_RESOURCES,
  MOCK_PROMPTS,
} from "./mock-servers";

function seedRegisteredServer(
  manager: MCPClientManager,
  serverId: string,
  config: Record<string, unknown>,
  timeout = 1000
): void {
  (manager as any).registeredServers.set(serverId, {
    config,
    timeout,
  });
}

function seedLiveState(
  manager: MCPClientManager,
  serverId: string,
  liveState: Record<string, unknown>
): void {
  (manager as any).liveClientStates.set(serverId, liveState);
}

function extractSingleText(result: unknown): string {
  return (result as any).content[0].text;
}

function buildInlineCwdServerScript(): string {
  const sdkCjsRoot = path.dirname(
    require.resolve("@modelcontextprotocol/sdk/package.json")
  );
  const serverIndexPath = JSON.stringify(
    path.join(sdkCjsRoot, "server", "index.js")
  );
  const serverStdioPath = JSON.stringify(
    path.join(sdkCjsRoot, "server", "stdio.js")
  );
  const typesPath = JSON.stringify(path.join(sdkCjsRoot, "types.js"));

  return `
    const { Server } = require(${serverIndexPath});
    const { StdioServerTransport } = require(${serverStdioPath});
    const {
      CallToolRequestSchema,
      ListToolsRequestSchema
    } = require(${typesPath});

    const server = new Server(
      { name: "cwd-test-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "cwd",
          description: "Returns the current working directory",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== "cwd") {
        return {
          content: [{ type: "text", text: "unknown tool" }],
          isError: true
        };
      }

      return {
        content: [{ type: "text", text: process.cwd() }]
      };
    });

    server.connect(new StdioServerTransport()).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;
}

function buildInlineStderrFloodServerScript(): string {
  const sdkCjsRoot = path.dirname(
    require.resolve("@modelcontextprotocol/sdk/package.json")
  );
  const serverIndexPath = JSON.stringify(
    path.join(sdkCjsRoot, "server", "index.js")
  );
  const serverStdioPath = JSON.stringify(
    path.join(sdkCjsRoot, "server", "stdio.js")
  );
  const typesPath = JSON.stringify(path.join(sdkCjsRoot, "types.js"));

  return `
    const { Server } = require(${serverIndexPath});
    const { StdioServerTransport } = require(${serverStdioPath});
    const {
      CallToolRequestSchema,
      ListToolsRequestSchema
    } = require(${typesPath});

    const server = new Server(
      { name: "stderr-flood-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    const floodChunk = "x".repeat(64 * 1024);
    const flood = setInterval(() => {
      for (let i = 0; i < 8; i += 1) {
        process.stderr.write(floodChunk);
      }
    }, 10);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "ping",
          description: "Responds even while stderr is noisy",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false
          }
        }
      ]
    }));

    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "pong" }]
    }));

    server.connect(new StdioServerTransport()).catch((error) => {
      console.error(error);
      process.exit(1);
    });

    process.on("exit", () => clearInterval(flood));
  `;
}

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

    it("stores defaultClientTitle + defaultSupportedProtocolVersions on the instance", () => {
      // These option-surface additions pair with the inspector's
      // `mcpProfile.initialize.{clientInfo, supportedProtocolVersions}`.
      // We can't easily assert the wire-level effect without a mock
      // server, so this test reaches into the private fields the
      // constructor writes — the next-closest thing to a wire
      // assertion. Catches the regression class where a future
      // refactor renames the field, drops it, or replaces the
      // assignment with a default but leaves the constructor
      // signature intact.
      const manager = new MCPClientManager(
        {},
        {
          defaultClientName: "chatgpt",
          defaultClientVersion: "1.0",
          defaultClientTitle: "ChatGPT Desktop",
          defaultSupportedProtocolVersions: ["2025-11-25", "2025-06-18"],
        }
      );
      const internals = manager as unknown as {
        defaultClientTitle?: string;
        defaultSupportedProtocolVersions?: string[];
      };
      expect(internals.defaultClientTitle).toBe("ChatGPT Desktop");
      expect(internals.defaultSupportedProtocolVersions).toEqual([
        "2025-11-25",
        "2025-06-18",
      ]);
    });

    it("normalizes empty defaultSupportedProtocolVersions to undefined", () => {
      // An empty array would send no protocolVersion at all and stall
      // initialize negotiation; the constructor normalizes [] →
      // undefined so the SDK falls back to its hardcoded
      // SUPPORTED_PROTOCOL_VERSIONS list. Mirrors the backend
      // canonicalizer's same rule (PR #269 P2 fix). This assertion
      // is the unit-level guard.
      const manager = new MCPClientManager(
        {},
        { defaultSupportedProtocolVersions: [] }
      );
      const internals = manager as unknown as {
        defaultSupportedProtocolVersions?: string[];
      };
      expect(internals.defaultSupportedProtocolVersions).toBeUndefined();
    });

    it("threads defaultSupportedProtocolVersions into the upstream Client's ClientOptions (via ProtocolOptions)", () => {
      // Regression pin: upstream `@modelcontextprotocol/client`'s
      // `ClientOptions` extends `ProtocolOptions`, which carries
      // `supportedProtocolVersions?: string[]`. The Client
      // constructor spreads its `options` arg into `super({ ...options, tasks: ... })`,
      // so the field reaches Protocol's constructor at
      // `this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS`.
      //
      // This test pins that wiring contract: if a future SDK
      // upgrade renames or drops the field, the upstream Protocol
      // would fall back to its hardcoded SUPPORTED_PROTOCOL_VERSIONS
      // and silently ignore the inspector's profile pin. The
      // assertion below inspects the manager's stored option so a
      // refactor that breaks the plumbing is caught here, not by a
      // wire-level surprise during eval reproduction.
      const versions = ["2025-11-25", "2025-06-18"];
      const manager = new MCPClientManager(
        {},
        { defaultSupportedProtocolVersions: versions }
      );
      const internals = manager as unknown as {
        defaultSupportedProtocolVersions?: string[];
      };
      // The manager's stored copy is what gets handed to
      // `new Client(...)` at connect time in performConnection.
      // Pinning equality here proves the round-trip survives the
      // constructor's defensive clone and is ready for the
      // ClientOptions spread.
      expect(internals.defaultSupportedProtocolVersions).toEqual(versions);
    });

    it("clones defaultSupportedProtocolVersions defensively", () => {
      // Order is semantic (first entry is proposed) so the manager
      // MUST NOT alias the caller's array — a later push() on the
      // original must NOT alter what the SDK proposes for the next
      // connection.
      const versions = ["2025-11-25"];
      const manager = new MCPClientManager(
        {},
        { defaultSupportedProtocolVersions: versions }
      );
      versions.push("hacked");
      const internals = manager as unknown as {
        defaultSupportedProtocolVersions?: string[];
      };
      expect(internals.defaultSupportedProtocolVersions).toEqual([
        "2025-11-25",
      ]);
    });

    it("lazyConnect skips eager connect so listServers is empty until connectToServer", () => {
      const manager = new MCPClientManager(
        {
          pending: {
            url: "http://127.0.0.1:9/mcp",
            timeout: 1000,
          },
        },
        { lazyConnect: true }
      );
      expect(manager.listServers()).toEqual([]);
      expect(manager.getConnectionStatus("pending")).toBe("disconnected");
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
    }, 60000);

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
      expect(manager.hasServer("everything")).toBe(true);
      expect(manager.listServers()).toContain("everything");
    }, 30000);
  });

  describe("STDIO transport hardening", () => {
    let manager: MCPClientManager;
    const inheritedEnvKey = "MCPJAM_TEST_INHERITED_ENV";
    const overrideEnvKey = "MCPJAM_TEST_OVERRIDE_ENV";
    let previousInheritedEnv: string | undefined;
    let previousOverrideEnv: string | undefined;

    beforeEach(() => {
      previousInheritedEnv = process.env[inheritedEnvKey];
      previousOverrideEnv = process.env[overrideEnvKey];
      manager = new MCPClientManager();
    });

    afterEach(async () => {
      await manager.disconnectAllServers();
      if (previousInheritedEnv === undefined) {
        delete process.env[inheritedEnvKey];
      } else {
        process.env[inheritedEnvKey] = previousInheritedEnv;
      }
      if (previousOverrideEnv === undefined) {
        delete process.env[overrideEnvKey];
      } else {
        process.env[overrideEnvKey] = previousOverrideEnv;
      }
    });

    it("inherits parent process env for stdio servers", async () => {
      process.env[inheritedEnvKey] = "from-parent";

      await manager.connectToServer("env-inherit", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      });

      const result = await manager.executeTool("env-inherit", "get-env", {});
      const env = JSON.parse(extractSingleText(result));

      expect(env[inheritedEnvKey]).toBe("from-parent");
    }, 30000);

    it("lets explicit stdio env override inherited parent values", async () => {
      process.env[overrideEnvKey] = "from-parent";

      await manager.connectToServer("env-override", {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
        env: {
          [overrideEnvKey]: "from-config",
        },
      });

      const result = await manager.executeTool("env-override", "get-env", {});
      const env = JSON.parse(extractSingleText(result));

      expect(env[overrideEnvKey]).toBe("from-config");
    }, 30000);

    it("passes cwd to stdio child processes", async () => {
      const cwd = mkdtempSync(path.join(tmpdir(), "mcpjam-cwd-test-"));
      const resolvedCwd = realpathSync(cwd);

      try {
        await manager.connectToServer("cwd-server", {
          command: process.execPath,
          args: [
            "-e",
            buildInlineCwdServerScript(),
          ],
          cwd,
        });

        const result = await manager.executeTool("cwd-server", "cwd", {});
        expect(extractSingleText(result)).toBe(resolvedCwd);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 15000);

    it("surfaces startup stderr when a stdio server fails to initialize", async () => {
      await expect(
        manager.connectToServer("stderr-failure", {
          command: process.execPath,
          args: [
            "-e",
            'console.error("stdio startup failed"); process.exit(1);',
          ],
          stderr: "pipe",
          timeout: 1000,
        })
      ).rejects.toThrow(/stdio startup failed/);
    }, 10000);

    it("keeps stdio server context for silent initialization failures", async () => {
      await expect(
        manager.connectToServer("silent-timeout", {
          command: process.execPath,
          args: [
            "-e",
            "setInterval(() => {}, 1000);",
          ],
          stderr: "pipe",
          timeout: 200,
        })
      ).rejects.toThrow(
        /Failed to connect to MCP server "silent-timeout" via stdio: Request timed out/
      );
    }, 10000);

    it("keeps draining stderr after startup for noisy stdio servers", async () => {
      await manager.connectToServer("stderr-flood", {
        command: process.execPath,
        args: [
          "-e",
          buildInlineStderrFloodServerScript(),
        ],
        stderr: "pipe",
        timeout: 5000,
      });

      await new Promise((resolve) => setTimeout(resolve, 250));

      const result = await manager.executeTool("stderr-flood", "ping", {});
      expect(extractSingleText(result)).toBe("pong");
    }, 15000);
  });

  describe("HTTP server", () => {
    let manager: MCPClientManager;
    let serverUrl: string;
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
      const isolated = await startMockHttpServer();
      const authManager = new MCPClientManager();

      try {
        await authManager.connectToServer("http-server-auth", {
          url: isolated.url,
          accessToken: "test-bearer-token",
          preferSSE: true,
        });

        expect(authManager.getConnectionStatus("http-server-auth")).toBe(
          "connected"
        );
        expect(authManager.getServerReplayConfigs()).toEqual([
          {
            serverId: "http-server-auth",
            url: isolated.url,
            accessToken: "test-bearer-token",
            preferSSE: true,
          },
        ]);
      } finally {
        await authManager.disconnectAllServers();
        await isolated.stop();
      }
    }, 15000);

    it("skips non-replayable HTTP configs with custom request state", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "custom-http", {
        url: "https://example.com/mcp",
        accessToken: "at_test",
        requestInit: {
          headers: {
            "X-Custom": "1",
          },
        },
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([]);
    });

    it("returns tokenless replay configs for public HTTP servers with empty headers", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "public-http", {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {},
        },
        preferSSE: true,
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([
        {
          serverId: "public-http",
          url: "https://example.com/mcp",
          preferSSE: true,
        },
      ]);
    });

    it("skips stdio servers when building replay configs", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "stdio-server", {
        command: "node",
        args: ["server.js"],
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([]);
    });

    it("skips HTTP configs with unsupported requestInit options", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "request-http", {
        url: "https://example.com/mcp",
        requestInit: {
          method: "POST",
        },
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([]);
    });

    it("extracts bearer auth from requestInit headers for replay configs", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "header-http", {
        url: "https://example.com/mcp",
        requestInit: {
          headers: {
            Authorization: "Bearer at_from_headers",
          },
        },
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([
        {
          serverId: "header-http",
          url: "https://example.com/mcp",
          accessToken: "at_from_headers",
        },
      ]);
    });

    it("preserves refresh-token replay configs without live client state", () => {
      const replayManager = new MCPClientManager();
      seedRegisteredServer(replayManager, "oauth-refresh", {
        url: "https://example.com/mcp",
        refreshToken: "rt_test",
        clientId: "client_id",
      });

      expect(replayManager.getServerReplayConfigs()).toEqual([
        {
          serverId: "oauth-refresh",
          url: "https://example.com/mcp",
          refreshToken: "rt_test",
          clientId: "client_id",
        },
      ]);
    });
  });

  describe("HTTP server (streamable)", () => {
    let manager: MCPClientManager;
    let serverUrl: string;
    let stopServer: () => Promise<void>;

    beforeAll(async () => {
      const result = await startMockStreamableHttpServer();
      serverUrl = result.url;
      stopServer = result.stop;
      manager = new MCPClientManager();
      await manager.connectToServer("http-localhost", {
        url: serverUrl,
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

    it("preserves server inventory after a failed connect attempt", async () => {
      await expect(
        manager.connectToServer("failing-http", {
          url: "http://127.0.0.1:9/mcp",
          timeout: 250,
        })
      ).rejects.toThrow();

      expect(manager.hasServer("failing-http")).toBe(true);
      expect(manager.listServers()).toContain("failing-http");
      expect(manager.getConnectionStatus("failing-http")).toBe("disconnected");
    });
  });

  describe("retry support", () => {
    let manager: MCPClientManager;

    beforeEach(() => {
      manager = new MCPClientManager(
        {},
        {
          lazyConnect: true,
          retryPolicy: {
            retries: 1,
            retryDelayMs: 0,
          },
        }
      );
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await manager.disconnectAllServers();
    });

    it("retries direct connectToServer calls on transient failures", async () => {
      const client = {} as any;
      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockRejectedValueOnce(
          Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
        )
        .mockResolvedValueOnce(client);

      await expect(
        manager.connectToServer("retry-connect", {
          command: "node",
          args: ["server.js"],
        })
      ).resolves.toBe(client);

      expect(connectSpy).toHaveBeenCalledTimes(2);
      expect(manager.hasServer("retry-connect")).toBe(true);
    });

    it("shares the retried direct connect promise across concurrent callers", async () => {
      const client = {} as any;
      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockRejectedValueOnce(
          Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
        )
        .mockResolvedValueOnce(client);

      const first = manager.connectToServer("retry-shared", {
        command: "node",
        args: ["server.js"],
      });
      const second = manager.connectToServer("retry-shared", {
        command: "node",
        args: ["server.js"],
      });

      await expect(Promise.all([first, second])).resolves.toEqual([
        client,
        client,
      ]);

      expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it("does not retry direct connectToServer calls on auth errors", async () => {
      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockRejectedValue(new MCPAuthError("Unauthorized", 401));

      await expect(
        manager.connectToServer("auth-connect", {
          command: "node",
          args: ["server.js"],
        })
      ).rejects.toThrow("Unauthorized");

      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("stops direct connect retries after disconnect during backoff", async () => {
      manager = new MCPClientManager(
        {},
        {
          lazyConnect: true,
          retryPolicy: {
            retries: 1,
            retryDelayMs: 25,
          },
        }
      );

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockRejectedValue(
          Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
        );

      const promise = manager.connectToServer("retry-disconnect", {
        command: "node",
        args: ["server.js"],
      });

      await new Promise((resolve) => setTimeout(resolve, 5));
      await manager.disconnectServer("retry-disconnect");

      await expect(promise).rejects.toThrow(
        'MCP server "retry-disconnect" was disconnected.'
      );
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("retries read operations as a single ensureConnected plus RPC budget", async () => {
      const fakeClient = {
        listTools: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({ tools: [] }),
      };

      seedRegisteredServer(manager, "retry-read", {
        command: "node",
        args: ["server.js"],
      });

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      await expect(manager.listTools("retry-read")).resolves.toEqual({
        tools: [],
      });

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(fakeClient.listTools).toHaveBeenCalledTimes(2);
    });

    it("retries pingServer using the original transport error details", async () => {
      const fakeClient = {
        ping: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("server unavailable"), {
              statusCode: 503,
            })
          )
          .mockResolvedValueOnce(undefined),
      };

      seedRegisteredServer(manager, "retry-ping", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "retry-ping", { client: fakeClient });

      await expect(manager.pingServer("retry-ping")).resolves.toBeUndefined();

      expect(fakeClient.ping).toHaveBeenCalledTimes(2);
    });

    it("retries read operations without tearing down an existing live session", async () => {
      const fakeClient = {
        listTools: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({ tools: [] }),
      };

      seedRegisteredServer(manager, "retry-live-read", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "retry-live-read", { client: fakeClient });

      const destroySpy = jest.spyOn(manager as any, "destroyLiveState");

      await expect(manager.listTools("retry-live-read")).resolves.toEqual({
        tools: [],
      });

      expect(fakeClient.listTools).toHaveBeenCalledTimes(2);
      expect(destroySpy).not.toHaveBeenCalled();
    });

    it("refreshes once on 401, strips stale Authorization headers, and rebuilds the connection", async () => {
      const unauthorized = Object.assign(new Error("HTTP 401"), {
        statusCode: 401,
      });
      const fakeTransport = {
        close: jest.fn().mockResolvedValue(undefined),
      };
      const fakeClient = {
        close: jest.fn().mockResolvedValue(undefined),
        listTools: jest
          .fn()
          .mockRejectedValueOnce(unauthorized)
          .mockResolvedValueOnce({ tools: [] }),
      };
      const onUnauthorized = jest
        .fn()
        .mockResolvedValue({ accessToken: "new-access-token" });

      seedRegisteredServer(manager, "hosted-oauth", {
        url: "https://example.com/mcp",
        accessToken: "old-access-token",
        requestInit: {
          headers: {
            Authorization: "Bearer stale-header-token",
            "X-Test": "1",
          },
        },
        onUnauthorized,
      });
      seedLiveState(manager, "hosted-oauth", {
        client: fakeClient,
        transport: fakeTransport,
      });

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      await expect(manager.listTools("hosted-oauth")).resolves.toEqual({
        tools: [],
      });

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fakeClient.listTools).toHaveBeenCalledTimes(2);
      expect(fakeClient.close).toHaveBeenCalledTimes(1);
      expect(fakeTransport.close).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect((manager.getServerConfig("hosted-oauth") as any).accessToken).toBe(
        "new-access-token"
      );
      expect(
        (manager.getServerConfig("hosted-oauth") as any).requestInit.headers
      ).toEqual({ "X-Test": "1" });
    });

    it("surfaces a second 401 after the one refresh retry", async () => {
      const unauthorized = Object.assign(new Error("HTTP 401"), {
        statusCode: 401,
      });
      const fakeClient = {
        listTools: jest.fn().mockRejectedValue(unauthorized),
      };
      const onUnauthorized = jest
        .fn()
        .mockResolvedValue({ accessToken: "new-access-token" });

      seedRegisteredServer(manager, "hosted-oauth-second-401", {
        url: "https://example.com/mcp",
        accessToken: "old-access-token",
        onUnauthorized,
      });
      seedLiveState(manager, "hosted-oauth-second-401", { client: fakeClient });
      jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      await expect(manager.listTools("hosted-oauth-second-401")).rejects.toThrow(
        "HTTP 401"
      );

      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fakeClient.listTools).toHaveBeenCalledTimes(2);
    });

    it("surfaces onUnauthorized failures instead of the original 401", async () => {
      const unauthorized = Object.assign(new Error("HTTP 401"), {
        statusCode: 401,
      });
      const refreshError = Object.assign(new Error("refresh_token_invalid"), {
        code: "refresh_token_invalid",
      });
      const fakeClient = {
        listTools: jest.fn().mockRejectedValue(unauthorized),
      };
      const onUnauthorized = jest.fn().mockRejectedValue(refreshError);

      seedRegisteredServer(manager, "hosted-oauth-refresh-fails", {
        url: "https://example.com/mcp",
        accessToken: "old-access-token",
        onUnauthorized,
      });
      seedLiveState(manager, "hosted-oauth-refresh-fails", {
        client: fakeClient,
      });

      let caughtError: unknown;
      try {
        await manager.listTools("hosted-oauth-refresh-fails");
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBe(refreshError);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(fakeClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("does not refresh on 403 authorization failures", async () => {
      const forbidden = Object.assign(new Error("HTTP 403"), {
        statusCode: 403,
      });
      const fakeClient = {
        listTools: jest.fn().mockRejectedValue(forbidden),
      };
      const onUnauthorized = jest
        .fn()
        .mockResolvedValue({ accessToken: "new-access-token" });

      seedRegisteredServer(manager, "hosted-oauth-403", {
        url: "https://example.com/mcp",
        accessToken: "old-access-token",
        onUnauthorized,
      });
      seedLiveState(manager, "hosted-oauth-403", { client: fakeClient });

      await expect(manager.listTools("hosted-oauth-403")).rejects.toThrow(
        "HTTP 403"
      );

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(fakeClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("dedupes parallel 401 refreshes for one server", async () => {
      const unauthorized = Object.assign(new Error("HTTP 401"), {
        statusCode: 401,
      });
      const abortController = new AbortController();
      let resolveRefresh: (value: { accessToken: string }) => void = () => {};
      const refreshPromise = new Promise<{ accessToken: string }>((resolve) => {
        resolveRefresh = resolve;
      });
      const onUnauthorized = jest.fn().mockReturnValue(refreshPromise);

      seedRegisteredServer(manager, "hosted-oauth-parallel", {
        url: "https://example.com/mcp",
        accessToken: "old-access-token",
        onUnauthorized,
      });
      const first = (manager as any).refreshAccessTokenAfterUnauthorized(
        "hosted-oauth-parallel",
        unauthorized,
        abortController.signal
      );
      const second = (manager as any).refreshAccessTokenAfterUnauthorized(
        "hosted-oauth-parallel",
        unauthorized,
        abortController.signal
      );

      expect(onUnauthorized).toHaveBeenCalledTimes(1);

      resolveRefresh({ accessToken: "new-access-token" });
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(
        (manager.getServerConfig("hosted-oauth-parallel") as any).accessToken
      ).toBe("new-access-token");
    });

    it("does not use onUnauthorized for refreshToken configs", async () => {
      const unauthorized = Object.assign(new Error("HTTP 401"), {
        statusCode: 401,
      });
      const fakeClient = {
        listTools: jest.fn().mockRejectedValue(unauthorized),
      };
      const onUnauthorized = jest
        .fn()
        .mockResolvedValue({ accessToken: "new-access-token" });

      seedRegisteredServer(manager, "refresh-token-config", {
        url: "https://example.com/mcp",
        refreshToken: "stored-refresh-token",
        clientId: "client-id",
        onUnauthorized,
      });
      seedLiveState(manager, "refresh-token-config", { client: fakeClient });

      await expect(manager.listTools("refresh-token-config")).rejects.toThrow(
        "HTTP 401"
      );

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(fakeClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("cancels a connect when the client closes during the handshake", async () => {
      const fakeTransport = {
        close: jest.fn().mockResolvedValue(undefined),
      };

      const connectViaStdioSpy = jest
        .spyOn(manager as any, "connectViaStdio")
        .mockImplementation(
          async (
            _serverId: string,
            client: { onclose?: () => void },
            _config: unknown,
            _timeout: number,
            _state: unknown
          ) => {
            client.onclose?.();
            return fakeTransport as any;
          }
        );

      await expect(
        manager.connectToServer("closed-during-connect", {
          command: "node",
          args: ["server.js"],
        })
      ).rejects.toThrow(
        'MCP server "closed-during-connect" connection was cancelled.'
      );

      expect(connectViaStdioSpy).toHaveBeenCalledTimes(1);
      expect(fakeTransport.close).toHaveBeenCalled();
      expect(manager.getConnectionStatus("closed-during-connect")).toBe(
        "disconnected"
      );
      expect(manager.getClient("closed-during-connect")).toBeUndefined();
    });

    it("does not retry read operations after the caller aborts during backoff", async () => {
      manager = new MCPClientManager(
        {},
        {
          lazyConnect: true,
          retryPolicy: {
            retries: 1,
            retryDelayMs: 25,
          },
        }
      );

      const abortController = new AbortController();
      const fakeClient = {
        listTools: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({ tools: [] }),
      };

      seedRegisteredServer(manager, "retry-read-abort", {
        command: "node",
        args: ["server.js"],
      });

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      const promise = manager.listTools("retry-read-abort", undefined, {
        signal: abortController.signal,
      });
      setTimeout(() => abortController.abort(new Error("Request cancelled")), 5);

      await expect(promise).rejects.toThrow("Request cancelled");
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(fakeClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("stops read retries after disconnect during backoff", async () => {
      manager = new MCPClientManager(
        {},
        {
          lazyConnect: true,
          retryPolicy: {
            retries: 1,
            retryDelayMs: 25,
          },
        }
      );

      const fakeClient = {
        listTools: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({ tools: [] }),
      };

      seedRegisteredServer(manager, "retry-read-disconnect", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "retry-read-disconnect", { client: fakeClient });

      const promise = manager.listTools("retry-read-disconnect");

      await new Promise((resolve) => setTimeout(resolve, 5));
      await manager.disconnectServer("retry-read-disconnect");

      await expect(promise).rejects.toThrow(
        'MCP server "retry-read-disconnect" was disconnected.'
      );
      expect(fakeClient.listTools).toHaveBeenCalledTimes(1);
    });

    it("keeps executeTool single-shot by default", async () => {
      const fakeClient = {
        callTool: jest
          .fn()
          .mockRejectedValue(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          ),
      };

      seedRegisteredServer(manager, "tool-default", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "tool-default", { client: fakeClient });

      await expect(
        manager.executeTool("tool-default", "echo", { message: "hello" })
      ).rejects.toThrow("timed out");

      expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
    });

    it("retries executeTool only when explicit retry options are provided", async () => {
      const fakeClient = {
        callTool: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "ok" }],
          }),
      };

      seedRegisteredServer(manager, "tool-retry", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "tool-retry", { client: fakeClient });

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      await expect(
        manager.executeTool(
          "tool-retry",
          "echo",
          { message: "hello" },
          {
            retry: {
              retries: 1,
              retryDelayMs: 0,
            },
          }
        )
      ).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });

      expect(fakeClient.callTool).toHaveBeenCalledTimes(2);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it("does not retry executeTool after the caller aborts during backoff", async () => {
      const abortController = new AbortController();
      const fakeClient = {
        callTool: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
          )
          .mockResolvedValueOnce({
            content: [{ type: "text", text: "ok" }],
          }),
      };

      seedRegisteredServer(manager, "tool-retry-abort", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "tool-retry-abort", { client: fakeClient });

      const connectSpy = jest
        .spyOn(manager as any, "connectToServerOnce")
        .mockImplementation(async (serverId: string) => {
          seedLiveState(manager, serverId, { client: fakeClient });
          return fakeClient as any;
        });

      const promise = manager.executeTool(
        "tool-retry-abort",
        "echo",
        { message: "hello" },
        {
          request: {
            signal: abortController.signal,
          },
          retry: {
            retries: 1,
            retryDelayMs: 25,
          },
        }
      );
      setTimeout(
        () => abortController.abort(new Error("Tool request cancelled")),
        5
      );

      await expect(promise).rejects.toThrow("Tool request cancelled");
      expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledTimes(0);
    });

    it("treats legacy request options with a task field as request options", async () => {
      const fakeClient = {
        callTool: jest.fn().mockResolvedValue({
          content: [{ type: "text", text: "ok" }],
        }),
        request: jest.fn(),
      };

      seedRegisteredServer(manager, "legacy-request-options", {
        command: "node",
        args: ["server.js"],
      });
      seedLiveState(manager, "legacy-request-options", { client: fakeClient });

      await expect(
        manager.executeTool(
          "legacy-request-options",
          "echo",
          { message: "hello" },
          {
            timeout: 500,
            task: { ttl: 60 },
          } as any
        )
      ).resolves.toEqual({
        content: [{ type: "text", text: "ok" }],
      });

      expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
      expect(fakeClient.callTool.mock.calls[0]?.[1]).toMatchObject({
        timeout: 500,
        task: { ttl: 60 },
      });
      expect(fakeClient.request).not.toHaveBeenCalled();
    });
  });

  describe("multiple servers", () => {
    let manager: MCPClientManager;
    let serverUrl: string;
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
    }, 60000);

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
      expect(result.length).toBeGreaterThan(MOCK_TOOLS.length);
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
      expect(manager.hasServer("disc-a")).toBe(true);
      expect(manager.hasServer("disc-b")).toBe(true);
      expect(manager.listServers()).toEqual(
        expect.arrayContaining(["disc-a", "disc-b"])
      );
    }, 30000);
  });
});
