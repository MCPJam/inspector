import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { Command } from "commander";

// Create mock function
const mockWithServer = jest.fn();

// Mock the client module before importing the command
jest.unstable_mockModule("../src/client.js", () => ({
  withServer: mockWithServer,
}));

// Import the command after mocking
const { registerPromptsCommand } = await import("../src/commands/prompts.js");

// Mock console methods
const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});
const mockProcessExit = jest
  .spyOn(process, "exit")
  .mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`Process exited with code ${code}`);
  });

describe("prompts command", () => {
  let program: Command;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");
    registerPromptsCommand(program);
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockProcessExit.mockRestore();
  });

  describe("prompts list", () => {
    it("should list prompts in table format", async () => {
      const mockPrompts = [
        { name: "greeting", description: "Greet the user" },
        { name: "farewell", description: "Say goodbye" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listPrompts: jest.fn().mockResolvedValue({ prompts: mockPrompts }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "prompts", "list", "-s", "npx test"]);

      expect(mockWithServer).toHaveBeenCalledWith("npx test", expect.any(Function));
      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("greeting");
      expect(output).toContain("Greet the user");
      expect(output).toContain("farewell");
    });

    it("should list prompts in JSON format", async () => {
      const mockPrompts = [{ name: "greeting", description: "Greet the user" }];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listPrompts: jest.fn().mockResolvedValue({ prompts: mockPrompts }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "--json", "prompts", "list", "-s", "npx test"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockPrompts, null, 2));
    });

    it("should show message when no prompts available", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listPrompts: jest.fn().mockResolvedValue({ prompts: [] }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "prompts", "list", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No prompts available");
    });

    it("should handle prompts with missing description", async () => {
      const mockPrompts = [{ name: "simple" }];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listPrompts: jest.fn().mockResolvedValue({ prompts: mockPrompts }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "prompts", "list", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("simple");
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Connection failed"));

      await expect(
        program.parseAsync(["node", "test", "prompts", "list", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("prompts get", () => {
    it("should get prompt and display messages", async () => {
      const mockResult = {
        description: "A simple greeting prompt",
        messages: [{ role: "user", content: { type: "text", text: "Hello, how are you?" } }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "greeting",
        "-s",
        "npx test",
      ]);

      // The first call has the description (Description: followed by description value)
      // and subsequent calls have the messages
      expect(mockConsoleLog).toHaveBeenCalled();
      const allCalls = mockConsoleLog.mock.calls.flat().map(String).join(" ");
      expect(allCalls).toContain("A simple greeting prompt");
      expect(allCalls).toContain("Hello, how are you?");
    });

    it("should get prompt with arguments", async () => {
      const mockResult = {
        messages: [{ role: "user", content: { type: "text", text: "Hello, Alice!" } }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "greeting",
        '{"name":"Alice"}',
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Hello, Alice!");
    });

    it("should display result in JSON format", async () => {
      const mockResult = {
        messages: [{ role: "user", content: { type: "text", text: "Test" } }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "--json",
        "prompts",
        "get",
        "simple",
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockResult, null, 2));
    });

    it("should handle string content format", async () => {
      const mockResult = {
        messages: [{ role: "user", content: "Plain text message" }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "simple",
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Plain text message");
    });

    it("should handle text property content format", async () => {
      const mockResult = {
        messages: [{ role: "assistant", content: { text: "Direct text property" } }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "simple",
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Direct text property");
    });

    it("should handle image content type", async () => {
      const mockResult = {
        messages: [{ role: "user", content: { type: "image", mimeType: "image/png" } }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "image-prompt",
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("[Image: image/png]");
    });

    it("should handle resource content type", async () => {
      const mockResult = {
        messages: [
          {
            role: "user",
            content: { type: "resource", resource: { uri: "file:///doc.txt" } },
          },
        ],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          getPrompt: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "prompts",
        "get",
        "resource-prompt",
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("[Resource: file:///doc.txt]");
    });

    it("should error on invalid JSON arguments", async () => {
      await expect(
        program.parseAsync([
          "node",
          "test",
          "prompts",
          "get",
          "greeting",
          "invalid-json",
          "-s",
          "npx test",
        ])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Prompt not found"));

      await expect(
        program.parseAsync([
          "node",
          "test",
          "prompts",
          "get",
          "missing",
          "-s",
          "npx test",
        ])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });
});
