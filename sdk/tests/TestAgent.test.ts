import { TestAgent } from "../src/TestAgent";

describe("TestAgent", () => {
  describe("constructor", () => {
    it("should create an instance with config", () => {
      const agent = new TestAgent({
        tools: [],
        llm: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(agent).toBeInstanceOf(TestAgent);
    });

    it("should accept optional parameters", () => {
      const agent = new TestAgent({
        tools: [],
        llm: "openai/gpt-4o",
        apiKey: "test-api-key",
        systemPrompt: "You are a test assistant.",
        temperature: 0.5,
      });

      expect(agent).toBeInstanceOf(TestAgent);
    });
  });

  describe("configuration", () => {
    it("should return the configured tools", () => {
      const mockTools = [
        {
          name: "test_tool",
          description: "A test tool",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ];

      const agent = new TestAgent({
        tools: mockTools,
        llm: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(agent.getTools()).toEqual(mockTools);
    });

    it("should update system prompt", () => {
      const agent = new TestAgent({
        tools: [],
        llm: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(() => agent.setSystemPrompt("New prompt")).not.toThrow();
    });

    it("should validate temperature range", () => {
      const agent = new TestAgent({
        tools: [],
        llm: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(() => agent.setTemperature(0.5)).not.toThrow();
      expect(() => agent.setTemperature(-1)).toThrow(
        "Temperature must be between 0 and 2"
      );
      expect(() => agent.setTemperature(3)).toThrow(
        "Temperature must be between 0 and 2"
      );
    });
  });
});
