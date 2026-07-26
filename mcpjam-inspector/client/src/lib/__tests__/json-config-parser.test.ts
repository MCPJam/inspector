import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseJsonConfig,
  validateJsonConfig,
  formatJsonConfig,
  type JsonConfig,
} from "../json-config-parser.js";
import type { ServerWithName } from "@/state/app-types";

// Mock console.warn to prevent noisy output
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("parseJsonConfig", () => {
  describe("STDIO server parsing", () => {
    it("parses a simple STDIO server config", () => {
      const json = JSON.stringify({
        mcpServers: {
          "my-server": {
            command: "node",
            args: ["server.js"],
          },
        },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "my-server",
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: {},
      });
    });

    it("parses STDIO server with environment variables", () => {
      const json = JSON.stringify({
        mcpServers: {
          "env-server": {
            command: "python",
            args: ["-m", "mcp_server"],
            env: {
              API_KEY: "secret123",
              DEBUG: "true",
            },
          },
        },
      });

      const result = parseJsonConfig(json);
      expect(result[0].env).toEqual({
        API_KEY: "secret123",
        DEBUG: "true",
      });
    });

    it("defaults args to empty array when not provided", () => {
      const json = JSON.stringify({
        mcpServers: {
          minimal: {
            command: "my-server-binary",
          },
        },
      });

      const result = parseJsonConfig(json);
      expect(result[0].args).toEqual([]);
    });
  });

  describe("HTTP/SSE server parsing", () => {
    it("parses SSE server with type field", () => {
      const json = JSON.stringify({
        mcpServers: {
          "sse-server": {
            type: "sse",
            url: "http://localhost:3000/mcp",
          },
        },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: "sse-server",
        type: "http",
        url: "http://localhost:3000/mcp",
        headers: {},
        env: {},
        useOAuth: false,
      });
    });

    it("parses HTTP server with just url (no type field)", () => {
      const json = JSON.stringify({
        mcpServers: {
          "http-server": {
            url: "http://localhost:4000/api",
          },
        },
      });

      const result = parseJsonConfig(json);
      expect(result[0].type).toBe("http");
      expect(result[0].url).toBe("http://localhost:4000/api");
    });
  });

  describe("multiple servers", () => {
    it("parses multiple servers of different types", () => {
      const json = JSON.stringify({
        mcpServers: {
          "stdio-1": { command: "node", args: ["s1.js"] },
          "stdio-2": { command: "python", args: ["s2.py"] },
          "http-1": { url: "http://localhost:3000" },
        },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(3);
      expect(result.map((s) => s.name)).toEqual([
        "stdio-1",
        "stdio-2",
        "http-1",
      ]);
    });
  });

  describe("error handling", () => {
    it("throws error for invalid JSON", () => {
      expect(() => parseJsonConfig("not valid json")).toThrow(
        "Invalid JSON format",
      );
    });

    it("treats an unknown wrapper key as a direct map and skips its invalid entry", () => {
      // `{servers: {}}` used to throw ('missing "mcpServers"'); with direct-map
      // support it is a map with one server named "servers" whose config has
      // neither command nor url — skipped, yielding zero servers.
      const json = JSON.stringify({ servers: {} });
      expect(parseJsonConfig(json)).toEqual([]);
    });

    it("throws error when mcpServers is not an object", () => {
      const json = JSON.stringify({ mcpServers: "not an object" });
      expect(() => parseJsonConfig(json)).toThrow(
        'missing or invalid "mcpServers"',
      );
    });

    it("throws when both mcp_servers and mcpServers are declared", () => {
      const json = JSON.stringify({
        mcpServers: { a: { command: "node" } },
        mcp_servers: { b: { command: "node" } },
      });
      expect(() => parseJsonConfig(json)).toThrow(
        'both "mcp_servers" and "mcpServers"',
      );
    });

    it("throws for a bare single server config", () => {
      const json = JSON.stringify({ command: "node", args: ["server.js"] });
      expect(() => parseJsonConfig(json)).toThrow("single server config");
    });

    it("skips servers with invalid config objects", () => {
      const json = JSON.stringify({
        mcpServers: {
          valid: { command: "node" },
          invalid: null,
        },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("valid");
    });

    it("skips servers missing both command and url", () => {
      const json = JSON.stringify({
        mcpServers: {
          incomplete: { args: ["something"] },
        },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(0);
    });
  });

  describe("compatible wrapper shapes (SDK plugin-bundle parity)", () => {
    const servers = {
      "stdio-server": {
        command: "node",
        args: ["server.js"],
        env: { API_KEY: "secret123" },
      },
      "http-server": { url: "https://example.com/mcp" },
    };

    it("imports mcpServers, mcp_servers, and direct maps identically", () => {
      const fromCamel = parseJsonConfig(
        JSON.stringify({ mcpServers: servers }),
      );
      const fromSnake = parseJsonConfig(
        JSON.stringify({ mcp_servers: servers }),
      );
      const fromDirect = parseJsonConfig(JSON.stringify(servers));

      expect(fromCamel).toHaveLength(2);
      expect(fromSnake).toEqual(fromCamel);
      expect(fromDirect).toEqual(fromCamel);
    });

    it("keeps env values byte-for-byte across shapes", () => {
      const fromDirect = parseJsonConfig(JSON.stringify(servers));
      const stdio = fromDirect.find((s) => s.name === "stdio-server");
      expect(stdio?.env).toEqual({ API_KEY: "secret123" });
    });

    it("treats a direct map containing a server NAMED url as a map", () => {
      // Only STRING command/url values indicate a bare single server; a
      // server object under the key "url" is a legitimate direct-map entry.
      const json = JSON.stringify({ url: { command: "node" } });
      const result = parseJsonConfig(json);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: "url", command: "node" });
    });
  });

  describe("transport classification (SDK detectPluginMcpTransport)", () => {
    it.each([
      ["streamable-http", "streamable-http"],
      ["streamable_http", "streamable_http"],
      ["streamableHttp", "streamableHttp"],
      ["uppercase", "STREAMABLE_HTTP"],
      ["http", "http"],
      ["sse", "sse"],
    ])("classifies %s as an HTTP server", (_label, type) => {
      const json = JSON.stringify({
        mcpServers: { remote: { type, url: "https://x.example.com/mcp" } },
      });
      expect(parseJsonConfig(json)[0].type).toBe("http");
    });

    it("honours an explicit stdio discriminator over a stray url guess", () => {
      const json = JSON.stringify({
        mcpServers: { local: { transport: "stdio", command: "node" } },
      });
      expect(parseJsonConfig(json)[0].type).toBe("stdio");
    });

    it("skips a server declaring an unknown transport", () => {
      const json = JSON.stringify({
        mcpServers: {
          good: { command: "node" },
          bad: { type: "carrier-pigeon", url: "https://x.example.com" },
        },
      });
      const result = parseJsonConfig(json);
      expect(result.map((s) => s.name)).toEqual(["good"]);
    });
  });

  describe("value preservation", () => {
    it("preserves HTTP headers", () => {
      // stdio `env` values have always survived the import; dropping headers
      // turned an otherwise valid import into a 401 at connect time.
      const json = JSON.stringify({
        mcp_servers: {
          remote: {
            url: "https://mcp.example.com/mcp",
            headers: { Authorization: "Bearer abc", "X-Trace": "1" },
          },
        },
      });

      expect(parseJsonConfig(json)[0].headers).toEqual({
        Authorization: "Bearer abc",
        "X-Trace": "1",
      });
    });

    it("drops non-string env and header values", () => {
      const json = JSON.stringify({
        mcpServers: {
          local: { command: "node", env: { OK: "1", BAD: 7, ALSO_BAD: null } },
        },
      });

      expect(parseJsonConfig(json)[0].env).toEqual({ OK: "1" });
    });

    it("keeps plain-HTTP URLs and free-form server names", () => {
      // The inspector is a debugger: the SDK's strict plugin rules (HTTPS
      // only, kebab-ish server keys) must not leak into this import path.
      const json = JSON.stringify({
        mcpServers: { "My Local Server": { url: "http://192.168.1.10/mcp" } },
      });

      const result = parseJsonConfig(json);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("My Local Server");
      expect(result[0].url).toBe("http://192.168.1.10/mcp");
    });
  });
});

describe("validateJsonConfig", () => {
  describe("valid configs", () => {
    it("returns success for valid STDIO config", () => {
      const json = JSON.stringify({
        mcpServers: {
          server: { command: "node" },
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("returns success for valid SSE config", () => {
      const json = JSON.stringify({
        mcpServers: {
          server: { type: "sse", url: "http://localhost:3000" },
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(true);
    });

    it("returns success for valid URL-only config", () => {
      const json = JSON.stringify({
        mcpServers: {
          server: { url: "http://localhost:3000" },
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(true);
    });

    it("returns success for an mcp_servers wrapper (OpenAI shape)", () => {
      const json = JSON.stringify({
        mcp_servers: {
          server: { command: "node" },
        },
      });

      expect(validateJsonConfig(json)).toEqual({ success: true });
    });

    it("returns success for a direct server map", () => {
      const json = JSON.stringify({
        server: { command: "node" },
      });

      expect(validateJsonConfig(json)).toEqual({ success: true });
    });
  });

  describe("invalid configs", () => {
    it("returns error for invalid JSON", () => {
      const result = validateJsonConfig("{ invalid json }");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid JSON format");
    });

    it("returns error for an empty document (empty direct map)", () => {
      // `{}` used to fail with 'Missing "mcpServers"'; with direct-map support
      // it is an empty server map.
      const result = validateJsonConfig(JSON.stringify({}));
      expect(result.success).toBe(false);
      expect(result.error).toContain("No servers found");
    });

    it("returns error when both wrappers are declared", () => {
      const result = validateJsonConfig(
        JSON.stringify({
          mcpServers: { a: { command: "node" } },
          mcp_servers: { a: { command: "node" } },
        }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('both "mcp_servers" and "mcpServers"');
    });

    it("returns error for a bare single server config", () => {
      const result = validateJsonConfig(
        JSON.stringify({ command: "node", args: [] }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("single server config");
    });

    it("returns error for empty mcpServers object", () => {
      const result = validateJsonConfig(JSON.stringify({ mcpServers: {} }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("No servers found");
    });

    it("returns error when server has neither command nor url", () => {
      const json = JSON.stringify({
        mcpServers: {
          incomplete: { args: ["arg1"] },
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'must have either "command" or "url" property',
      );
    });

    it("returns error when server has both command and url", () => {
      const json = JSON.stringify({
        mcpServers: {
          conflicting: {
            command: "node",
            url: "http://localhost:3000",
          },
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(false);
      expect(result.error).toContain(
        'cannot have both "command" and "url" properties',
      );
    });

    it("returns error for null server config", () => {
      const json = JSON.stringify({
        mcpServers: {
          nullServer: null,
        },
      });

      const result = validateJsonConfig(json);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid server config");
    });
  });
});

describe("formatJsonConfig", () => {
  it("formats STDIO servers correctly", () => {
    const servers: Record<string, ServerWithName> = {
      "my-server": {
        name: "my-server",
        connectionStatus: "connected",
        config: {
          command: "node",
          args: ["server.js"],
        },
      },
    };

    const result = formatJsonConfig(servers);
    expect(result).toEqual({
      mcpServers: {
        "my-server": {
          command: "node",
          args: ["server.js"],
        },
      },
    });
  });

  it("formats HTTP/SSE servers correctly", () => {
    const servers: Record<string, ServerWithName> = {
      "http-server": {
        name: "http-server",
        connectionStatus: "connected",
        config: {
          url: new URL("http://localhost:3000/mcp"),
        },
      },
    };

    const result = formatJsonConfig(servers);
    expect(result).toEqual({
      mcpServers: {
        "http-server": {
          type: "sse",
          url: "http://localhost:3000/mcp",
        },
      },
    });
  });

  it("includes env only when present", () => {
    const servers: Record<string, ServerWithName> = {
      "with-env": {
        name: "with-env",
        connectionStatus: "connected",
        config: {
          command: "python",
          args: ["-m", "server"],
          env: { API_KEY: "secret" },
        },
      },
      "without-env": {
        name: "without-env",
        connectionStatus: "connected",
        config: {
          command: "node",
          args: [],
        },
      },
    };

    const result = formatJsonConfig(servers);
    expect(result.mcpServers["with-env"].env).toEqual({ API_KEY: "secret" });
    expect(result.mcpServers["without-env"].env).toBeUndefined();
  });

  it("handles empty env object by not including it", () => {
    const servers: Record<string, ServerWithName> = {
      "empty-env": {
        name: "empty-env",
        connectionStatus: "connected",
        config: {
          command: "node",
          args: [],
          env: {},
        },
      },
    };

    const result = formatJsonConfig(servers);
    expect(result.mcpServers["empty-env"].env).toBeUndefined();
  });

  it("skips servers with missing url or command", () => {
    const servers: Record<string, ServerWithName> = {
      incomplete: {
        name: "incomplete",
        connectionStatus: "disconnected",
        config: {},
      },
      valid: {
        name: "valid",
        connectionStatus: "connected",
        config: { command: "node" },
      },
    };

    const result = formatJsonConfig(servers);
    expect(Object.keys(result.mcpServers)).toEqual(["valid"]);
  });

  it("defaults args to empty array when not provided", () => {
    const servers: Record<string, ServerWithName> = {
      "no-args": {
        name: "no-args",
        connectionStatus: "connected",
        config: {
          command: "my-binary",
        },
      },
    };

    const result = formatJsonConfig(servers);
    expect(result.mcpServers["no-args"].args).toEqual([]);
  });
});
