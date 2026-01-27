import { jest, describe, it, expect, beforeEach, afterAll } from "@jest/globals";
import { Command } from "commander";

// Create mock function
const mockWithServer = jest.fn();

// Mock the client module before importing the command
jest.unstable_mockModule("../src/client.js", () => ({
  withServer: mockWithServer,
}));

// Import the command after mocking
const { registerResourcesCommand } = await import("../src/commands/resources.js");

// Mock console methods
const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});
const mockProcessExit = jest
  .spyOn(process, "exit")
  .mockImplementation((code?: string | number | null | undefined): never => {
    throw new Error(`Process exited with code ${code}`);
  });

describe("resources command", () => {
  let program: Command;

  beforeEach(() => {
    jest.clearAllMocks();
    program = new Command();
    program.option("--json", "Output as JSON").option("-q, --quiet", "Minimal output");
    registerResourcesCommand(program);
  });

  afterAll(() => {
    mockConsoleLog.mockRestore();
    mockConsoleError.mockRestore();
    mockProcessExit.mockRestore();
  });

  describe("resources list", () => {
    it("should list resources in table format", async () => {
      const mockResources = [
        { uri: "file:///test.txt", name: "test.txt", mimeType: "text/plain" },
        { uri: "file:///data.json", name: "data.json", mimeType: "application/json" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResources: jest.fn().mockResolvedValue({ resources: mockResources }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "list", "-s", "npx test"]);

      expect(mockWithServer).toHaveBeenCalledWith("npx test", expect.any(Function));
      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("file:///test.txt");
      expect(output).toContain("test.txt");
      expect(output).toContain("text/plain");
    });

    it("should list resources in JSON format", async () => {
      const mockResources = [
        { uri: "file:///test.txt", name: "test.txt", mimeType: "text/plain" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResources: jest.fn().mockResolvedValue({ resources: mockResources }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "--json", "resources", "list", "-s", "npx test"]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockResources, null, 2));
    });

    it("should show message when no resources available", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResources: jest.fn().mockResolvedValue({ resources: [] }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "list", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No resources available");
    });

    it("should handle resources with missing optional fields", async () => {
      const mockResources = [{ uri: "file:///test.txt" }];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResources: jest.fn().mockResolvedValue({ resources: mockResources }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "list", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("file:///test.txt");
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Connection failed"));

      await expect(
        program.parseAsync(["node", "test", "resources", "list", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("resources read", () => {
    it("should read and display text resource", async () => {
      const mockResult = {
        contents: [{ text: "Hello, World!", mimeType: "text/plain" }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          readResource: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "resources",
        "read",
        "file:///test.txt",
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith("Hello, World!");
    });

    it("should read and display resource in JSON format", async () => {
      const mockResult = {
        contents: [{ text: "Content", mimeType: "text/plain" }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          readResource: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "--json",
        "resources",
        "read",
        "file:///test.txt",
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockResult, null, 2));
    });

    it("should handle blob content", async () => {
      const mockResult = {
        contents: [{ blob: "base64data", mimeType: "image/png" }],
      };

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          readResource: jest.fn().mockResolvedValue(mockResult),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "resources",
        "read",
        "file:///image.png",
        "-s",
        "npx test",
      ]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("[Binary data: image/png]");
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Resource not found"));

      await expect(
        program.parseAsync([
          "node",
          "test",
          "resources",
          "read",
          "file:///missing.txt",
          "-s",
          "npx test",
        ])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe("resources templates", () => {
    it("should list resource templates in table format", async () => {
      const mockTemplates = [
        {
          uriTemplate: "file:///{path}",
          name: "File Template",
          description: "Read any file",
        },
        {
          uriTemplate: "db:///{table}/{id}",
          name: "DB Template",
          description: "Query database",
        },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResourceTemplates: jest
            .fn()
            .mockResolvedValue({ resourceTemplates: mockTemplates }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "templates", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("file:///{path}");
      expect(output).toContain("File Template");
      expect(output).toContain("Read any file");
    });

    it("should list resource templates in JSON format", async () => {
      const mockTemplates = [
        { uriTemplate: "file:///{path}", name: "File Template" },
      ];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResourceTemplates: jest
            .fn()
            .mockResolvedValue({ resourceTemplates: mockTemplates }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync([
        "node",
        "test",
        "--json",
        "resources",
        "templates",
        "-s",
        "npx test",
      ]);

      expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(mockTemplates, null, 2));
    });

    it("should show message when no templates available", async () => {
      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResourceTemplates: jest.fn().mockResolvedValue({ resourceTemplates: [] }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "templates", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("No resource templates available");
    });

    it("should handle templates with missing optional fields", async () => {
      const mockTemplates = [{ uriTemplate: "file:///{path}" }];

      mockWithServer.mockImplementation(async (_: unknown, operation: Function) => {
        const mockManager = {
          listResourceTemplates: jest
            .fn()
            .mockResolvedValue({ resourceTemplates: mockTemplates }),
        };
        return operation(mockManager, "cli-server");
      });

      await program.parseAsync(["node", "test", "resources", "templates", "-s", "npx test"]);

      const output = mockConsoleLog.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("file:///{path}");
    });

    it("should handle errors", async () => {
      mockWithServer.mockRejectedValue(new Error("Method not found"));

      await expect(
        program.parseAsync(["node", "test", "resources", "templates", "-s", "npx test"])
      ).rejects.toThrow("Process exited with code 1");

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });
});
