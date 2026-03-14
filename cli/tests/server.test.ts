import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { Command } from "commander";

// Create mock function
const mockWithServer = jest.fn();

// Mock the client module before importing the command
jest.unstable_mockModule("../src/client.js", () => ({
  withServer: mockWithServer,
}));

// Import the command after mocking
const { registerServerCommand } = await import("../src/commands/server.js");

// Mock console methods
const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});
const mockProcessExit = jest
  .spyOn(process, "exit")
  .mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`Process exited with code ${code}`);
  });

describe("server command", () => {
  let program: Command;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");
    registerServerCommand(program);
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockProcessExit.mockRestore();
  });

  describe("server info", () => {
    it("should display server info in table format", async () => {
      const mockInfo = {
        transport: "stdio",
        protocolVersion: "2024-11-05",
        serverVersion: { name: "test-server", version: "1.0.0" },
        instructions: "Test server instructions",
      };
      const mockCapabilities = {
        tools: {},
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
        logging: {},
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(mockInfo),
          getServerCapabilities: jest.fn().mockReturnValue(mockCapabilities),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "server", "info", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("test-server");
      expect(output).toContain("1.0.0");
      expect(output).toContain("stdio");
      expect(output).toContain("2024-11-05");
      expect(output).toContain("Test server instructions");
      expect(output).toContain("tools");
      expect(output).toContain("resources");
      expect(output).toContain("resources.subscribe");
      expect(output).toContain("prompts");
      expect(output).toContain("logging");
    });

    it("should display server info in JSON format", async () => {
      const mockInfo = {
        transport: "stdio",
        serverVersion: { name: "test-server", version: "1.0.0" },
      };
      const mockCapabilities = { tools: {} };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(mockInfo),
          getServerCapabilities: jest.fn().mockReturnValue(mockCapabilities),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "--json", "server", "info", "-s", "npx test"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(
        JSON.stringify({ info: mockInfo, capabilities: mockCapabilities }, null, 2)
      );
    });

    it("should handle missing server version", async () => {
      const mockInfo = {
        transport: "sse",
      };
      const mockCapabilities = { tools: {} };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(mockInfo),
          getServerCapabilities: jest.fn().mockReturnValue(mockCapabilities),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "server", "info", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("sse");
    });

    it("should handle experimental capabilities", async () => {
      const mockInfo = { transport: "stdio" };
      const mockCapabilities = {
        experimental: {
          tasks: {},
          elicitation: {},
        },
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(mockInfo),
          getServerCapabilities: jest.fn().mockReturnValue(mockCapabilities),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "server", "info", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("experimental.tasks");
      expect(output).toContain("experimental.elicitation");
    });

    it("should handle no capabilities", async () => {
      const mockInfo = { transport: "stdio" };
      const mockCapabilities = {};

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(mockInfo),
          getServerCapabilities: jest.fn().mockReturnValue(mockCapabilities),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "server", "info", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No capabilities reported");
    });

    it("should handle undefined info and capabilities", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getInitializationInfo: jest.fn().mockReturnValue(undefined),
          getServerCapabilities: jest.fn().mockReturnValue(undefined),
        };
        return operation(mockManager, "cli-server");
      });

      // Should not throw
      await program.parseAsync(["node", "test", "server", "info", "-s", "npx test"]);
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Connection failed"));

      await expect(
        program.parseAsync(["node", "test", "server", "info", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("server ping", () => {
    it("should ping server and show success", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          pingServer: jest.fn(),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "server", "ping", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Server is reachable");
    });

    it("should show success in JSON format", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          pingServer: jest.fn(),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "--json", "server", "ping", "-s", "npx test"]);

      const logCalls = mockConsoleLog.mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);
      const jsonOutput = JSON.parse(String(logCalls[0][0]));
      expect(jsonOutput.success).toBe(true);
      expect(jsonOutput).toHaveProperty("elapsed_ms");
    });

    it("should handle ping failure", async () => {
      mockWithServer.mockRejectedValue(new Error("Server not responding"));

      await expect(
        program.parseAsync(["node", "test", "server", "ping", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      const output = mockConsoleError.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Server not responding");
    });

    it("should show failure in JSON format", async () => {
      mockWithServer.mockRejectedValue(new Error("Connection refused"));

      await expect(
        program.parseAsync(["node", "test", "--json", "server", "ping", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      const logCalls = mockConsoleLog.mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);
      const jsonOutput = JSON.parse(String(logCalls[0][0]));
      expect(jsonOutput.success).toBe(false);
      expect(jsonOutput.error).toBe("Connection refused");
    });
  });
});
