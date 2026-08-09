import { describe, it, expect } from "vitest";
import { parseFirstRunServerInput } from "../first-run-server-input";

const local = { hostedMode: false };
const hosted = { hostedMode: true };

function parseOk(raw: string, options = local) {
  const result = parseFirstRunServerInput(raw, options);
  if (!result.ok) {
    throw new Error(`expected a parse, got error: ${result.error}`);
  }
  return result.formData;
}

function parseErr(raw: string, options = local) {
  const result = parseFirstRunServerInput(raw, options);
  if (result.ok) {
    throw new Error(`expected an error, got ${JSON.stringify(result.formData)}`);
  }
  return result.error;
}

describe("parseFirstRunServerInput", () => {
  it("rejects empty input", () => {
    expect(parseErr("")).toBe("Enter a server URL or command.");
    expect(parseErr("   ")).toBe("Enter a server URL or command.");
  });

  describe("http servers", () => {
    it("parses a full https URL", () => {
      expect(parseOk("https://mcp.excalidraw.com/mcp")).toEqual({
        name: "Excalidraw",
        type: "http",
        url: "https://mcp.excalidraw.com/mcp",
        useOAuth: false,
      });
    });

    it("accepts plain http for local servers", () => {
      const form = parseOk("http://localhost:3000/mcp");
      expect(form.type).toBe("http");
      expect(form.url).toBe("http://localhost:3000/mcp");
    });

    it("promotes a bare host to https", () => {
      const form = parseOk("mcp.example.com/mcp");
      expect(form.type).toBe("http");
      expect(form.url).toBe("https://mcp.example.com/mcp");
    });

    it("trims surrounding whitespace", () => {
      expect(parseOk("  https://mcp.example.com/mcp  ").url).toBe(
        "https://mcp.example.com/mcp"
      );
    });

    it("rejects transports it cannot speak", () => {
      expect(parseErr("ws://mcp.example.com")).toContain("ws");
      expect(parseErr("file:///tmp/server")).toContain("file");
    });

    describe("name derivation", () => {
      it.each([
        ["https://mcp.excalidraw.com/mcp", "Excalidraw"],
        ["https://mcp.linear.app/sse", "Linear"],
        ["https://www.notion.com/mcp", "Notion"],
        ["https://api.githubcopilot.com/mcp", "Githubcopilot"],
        ["https://mcp.acme.co.uk/mcp", "Acme"],
      ])("%s -> %s", (url, expected) => {
        expect(parseOk(url).name).toBe(expected);
      });

      it("falls back to the hostname when there is no label to take", () => {
        expect(parseOk("http://localhost:3000/mcp").name).toBe("Localhost");
      });
    });
  });

  describe("stdio servers", () => {
    it("splits a command line into command and args", () => {
      expect(parseOk("npx -y @acme/weather-mcp")).toEqual({
        name: "Weather Mcp",
        type: "stdio",
        command: "npx",
        args: ["-y", "@acme/weather-mcp"],
      });
    });

    it("handles a bare command", () => {
      expect(parseOk("my-server")).toEqual({
        name: "My Server",
        type: "stdio",
        command: "my-server",
        args: [],
      });
    });

    it("collapses repeated whitespace between args", () => {
      expect(parseOk("uv   run    server.py").args).toEqual([
        "run",
        "server.py",
      ]);
    });

    it("names from the last non-flag argument, not the runner", () => {
      expect(parseOk("uv run server.py").name).toBe("Server");
      expect(parseOk("node ./dist/index.js --verbose").name).toBe("Index");
    });

    it("refuses stdio in hosted mode with an actionable message", () => {
      const error = parseErr("npx -y @acme/weather-mcp", hosted);
      expect(error).toContain("HTTP server URL");
    });

    it("still accepts http URLs in hosted mode", () => {
      expect(parseOk("https://mcp.example.com/mcp", hosted).type).toBe("http");
    });
  });
});
