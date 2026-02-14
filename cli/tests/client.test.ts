import { describe, it, expect } from "@jest/globals";
import { parseServerOption } from "../src/client.js";

// Only test parseServerOption since withServer requires actual SDK integration
// Integration tests with withServer would need a real MCP server

describe("client", () => {
  describe("parseServerOption", () => {
    it("should parse HTTP URL", () => {
      const config = parseServerOption("http://localhost:3000/mcp");
      expect(config).toEqual({ url: "http://localhost:3000/mcp" });
    });

    it("should parse HTTPS URL", () => {
      const config = parseServerOption("https://api.example.com/mcp");
      expect(config).toEqual({ url: "https://api.example.com/mcp" });
    });

    it("should parse STDIO command without args", () => {
      const config = parseServerOption("npx");
      expect(config).toEqual({ command: "npx", args: [] });
    });

    it("should parse STDIO command with single arg", () => {
      const config = parseServerOption("npx @modelcontextprotocol/server-fs");
      expect(config).toEqual({
        command: "npx",
        args: ["@modelcontextprotocol/server-fs"],
      });
    });

    it("should parse STDIO command with multiple args", () => {
      const config = parseServerOption("npx @modelcontextprotocol/server-fs /tmp /var");
      expect(config).toEqual({
        command: "npx",
        args: ["@modelcontextprotocol/server-fs", "/tmp", "/var"],
      });
    });

    it("should parse node command", () => {
      const config = parseServerOption("node ./server.js --port 3000");
      expect(config).toEqual({
        command: "node",
        args: ["./server.js", "--port", "3000"],
      });
    });

    it("should parse command with quoted paths", () => {
      const config = parseServerOption("node /path/to/server.js arg1 arg2");
      expect(config).toEqual({
        command: "node",
        args: ["/path/to/server.js", "arg1", "arg2"],
      });
    });

    it("should parse python command", () => {
      const config = parseServerOption("python -m mcp_server");
      expect(config).toEqual({
        command: "python",
        args: ["-m", "mcp_server"],
      });
    });
  });
});
