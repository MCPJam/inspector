import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { Command } from "commander";

// Create mock functions
const mockListTools = jest.fn();
const mockExecuteTool = jest.fn();
const mockWithServer = jest.fn();

// Mock the client module before importing the command
jest.unstable_mockModule("../src/client.js", () => ({
  withServer: mockWithServer,
}));

// Import the command after mocking
const { registerToolsCommand } = await import("../src/commands/tools.js");

// Mock console methods
const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});
const mockProcessExit = jest
  .spyOn(process, "exit")
  .mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`Process exited with code ${code}`);
  });

describe("tools command", () => {
  let program: Command;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");
    registerToolsCommand(program);
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockProcessExit.mockRestore();
  });

  describe("tools list", () => {
    it("should list tools in table format", async () => {
      const mockTools = [
        { name: "echo", description: "Echoes back input" },
        { name: "add", description: "Adds two numbers" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "list", "-s", "npx test"]);

      expect(mockWithServer).toHaveBeenCalledWith("npx test", expect.any(Function));
      expect(mockConsoleLog).toHaveBeenCalled();
      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("echo");
      expect(output).toContain("add");
    });

    it("should list tools in JSON format", async () => {
      const mockTools = [
        { name: "echo", description: "Echoes back input" },
        { name: "add", description: "Adds two numbers" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({ tools: mockTools }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "--json", "tools", "list", "-s", "npx test"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockTools, null, 2));
    });

    it("should show message when no tools available", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({ tools: [] }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "list", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No tools available");
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Connection failed"));

      await expect(
        program.parseAsync(["node", "test", "tools", "list", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("tools call", () => {
    it("should call tool and display text result", async () => {
      const mockResult = {
        content: [{ type: "text", text: "Echo: Hello" }],
        isError: false,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "tools",
        "call",
        "echo",
        '{"message":"Hello"}',
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Echo: Hello");
    });

    it("should call tool with no arguments", async () => {
      const mockResult = {
        content: [{ type: "text", text: "No args" }],
        isError: false,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "call", "noargs", "-s", "npx test"]);

      expect(mockConsoleLog).toHaveBeenCalledWith("No args");
    });

    it("should display result in JSON format", async () => {
      const mockResult = {
        content: [{ type: "text", text: "Result" }],
        isError: false,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "--json",
        "tools",
        "call",
        "echo",
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockResult, null, 2));
    });

    it("should handle image content type", async () => {
      const mockResult = {
        content: [{ type: "image", mimeType: "image/png" }],
        isError: false,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "call", "screenshot", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("[Image: image/png]");
    });

    it("should handle resource content type", async () => {
      const mockResult = {
        content: [{ type: "resource", resource: { uri: "file:///test.txt" } }],
        isError: false,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "call", "getfile", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("[Resource: file:///test.txt]");
    });

    it("should handle tool error result", async () => {
      const mockResult = {
        content: [{ type: "text", text: "Error occurred" }],
        isError: true,
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await expect(
        program.parseAsync(["node", "test", "tools", "call", "failing", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");
    });

    it("should handle task results", async () => {
      const mockResult = {
        task: { id: "task-123", status: "running" },
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          executeTool: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "tools", "call", "longtask", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Task started:");
      expect(output).toContain("task-123");
    });

    it("should error on invalid JSON arguments", async () => {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "tools",
          "call",
          "echo",
          "invalid-json",
          "-s",
          "npx test",
        ])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });
});
