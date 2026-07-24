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

  describe("compatible config shapes (mcp_servers / direct)", () => {
    // The three shapes must import IDENTICALLY (acceptance criterion of INS-1):
    // an OpenAI `mcp_servers` wrapper, a direct server map, and the legacy
    // `mcpServers` wrapper all produce the same ServerFormData.
    const expected = [
      {
        name: "svr",
        type: "stdio" as const,
        command: "node",
        args: ["server.js"],
        env: {},
      },
    ];

    it("parses the mcpServers wrapper (legacy)", () => {
      const json = JSON.stringify({
        mcpServers: { svr: { command: "node", args: ["server.js"] } },
      });
      expect(parseJsonConfig(json)).toEqual(expected);
    });

    it("parses the mcp_servers wrapper identically", () => {
      const json = JSON.stringify({
        mcp_servers: { svr: { command: "node", args: ["server.js"] } },
      });
      expect(parseJsonConfig(json)).toEqual(expected);
    });

    it("parses a direct server map identically", () => {
      const json = JSON.stringify({
        svr: { command: "node", args: ["server.js"] },
      });
      expect(parseJsonConfig(json)).toEqual(expected);
    });

    it("preserves env values across all three shapes", () => {
      const server = { command: "python", env: { API_KEY: "secret123" } };
      const direct = parseJsonConfig(JSON.stringify({ s: server }));
      const snake = parseJsonConfig(JSON.stringify({ mcp_servers: { s: server } }));
      const camel = parseJsonConfig(JSON.stringify({ mcpServers: { s: server } }));
      expect(direct).toEqual(snake);
      expect(snake).toEqual(camel);
      expect(direct[0].env).toEqual({ API_KEY: "secret123" });
    });

    it("validates mcp_servers and direct shapes as success", () => {
      expect(
        validateJsonConfig(
          JSON.stringify({ mcp_servers: { s: { command: "node" } } }),
        ).success,
      ).toBe(true);
      expect(
        validateJsonConfig(
          JSON.stringify({ s: { url: "https://x/mcp" } }),
        ).success,
      ).toBe(true);
    });

    it("rejects declaring both wrappers", () => {
      const json = JSON.stringify({
        mcp_servers: { a: { command: "x" } },
        mcpServers: { b: { command: "y" } },
      });
      expect(() => parseJsonConfig(json)).toThrow(
        'cannot declare both "mcp_servers" and "mcpServers"',
      );
      expect(validateJsonConfig(json).error).toContain(
        'Cannot declare both "mcp_servers" and "mcpServers"',
      );
    });

    it("carries HTTP headers through on the new shapes (credentials)", () => {
      const server = {
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer tok", "X-Api-Key": "abc" },
      };
      const snake = parseJsonConfig(
        JSON.stringify({ mcp_servers: { s: server } }),
      );
      const direct = parseJsonConfig(JSON.stringify({ s: server }));
      expect(snake[0].headers).toEqual({
        Authorization: "Bearer tok",
        "X-Api-Key": "abc",
      });
      expect(direct[0].headers).toEqual(snake[0].headers);
    });

    it("tolerates non-object sibling keys in a direct map", () => {
      const json = JSON.stringify({
        version: "1.0",
        s: { command: "node" },
      });
      expect(validateJsonConfig(json).success).toBe(true);
      const servers = parseJsonConfig(json);
      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe("s");
    });

    it("rejects an SSE/HTTP entry with no URL", () => {
      const json = JSON.stringify({ mcp_servers: { s: { type: "sse" } } });
      const result = validateJsonConfig(json);
      expect(result.success).toBe(false);
      expect(result.error).toContain('must have a non-empty "url"');
      // And it is not imported as an empty, unusable server.
      expect(parseJsonConfig(json)).toHaveLength(0);
    });

    it("imports a stdio entry that carries an empty url as stdio (not skipped)", () => {
      // A present-but-empty `url: ""` must NOT route a command entry to HTTP and
      // get it skipped for a missing URL. validate must accept it AND parse must
      // import exactly one stdio server (never a validated-but-imports-nothing
      // config).
      const json = JSON.stringify({
        mcp_servers: {
          local: { command: "node", args: ["server.js"], url: "" },
        },
      });
      expect(validateJsonConfig(json).success).toBe(true);
      const servers = parseJsonConfig(json);
      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: "local",
        type: "stdio",
        command: "node",
        args: ["server.js"],
      });
    });
  });

  describe("error handling", () => {
    it("throws error for invalid JSON", () => {
      expect(() => parseJsonConfig("not valid json")).toThrow(
        "Invalid JSON format",
      );
    });

    it("throws error when mcpServers is missing", () => {
      const json = JSON.stringify({ servers: {} });
      expect(() => parseJsonConfig(json)).toThrow(
        'missing or invalid "mcpServers"',
      );
    });

    it("throws error when mcpServers is not an object", () => {
      const json = JSON.stringify({ mcpServers: "not an object" });
      expect(() => parseJsonConfig(json)).toThrow(
        'missing or invalid "mcpServers"',
      );
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
  });

  describe("invalid configs", () => {
    it("returns error for invalid JSON", () => {
      const result = validateJsonConfig("{ invalid json }");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid JSON format");
    });

    it("returns error when mcpServers is missing", () => {
      const result = validateJsonConfig(JSON.stringify({}));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing or invalid "mcpServers"');
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
