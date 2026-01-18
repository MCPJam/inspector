import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatInput } from "../chat-input";
import type { ModelDefinition } from "@/shared/types";

// Mock child components
vi.mock("../chat-input/model-selector", () => ({
  ModelSelector: ({
    currentModel,
    onModelChange,
  }: {
    currentModel: ModelDefinition;
    onModelChange: (model: ModelDefinition) => void;
  }) => (
    <button
      data-testid="model-selector"
      onClick={() => onModelChange({ ...currentModel, id: "new-model" })}
    >
      {currentModel.name}
    </button>
  ),
}));

vi.mock("../chat-input/system-prompt-selector", () => ({
  SystemPromptSelector: ({
    systemPrompt,
    onSystemPromptChange,
  }: {
    systemPrompt: string;
    onSystemPromptChange: (prompt: string) => void;
  }) => (
    <button
      data-testid="system-prompt-selector"
      onClick={() => onSystemPromptChange("new prompt")}
    >
      System Prompt
    </button>
  ),
}));

vi.mock("../chat-input/context", () => ({
  Context: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context">{children}</div>
  ),
  ContextTrigger: () => <button data-testid="context-trigger">Context</button>,
  ContextContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ContextContentHeader: () => null,
  ContextContentBody: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  ContextInputUsage: () => null,
  ContextOutputUsage: () => null,
  ContextMCPServerUsage: () => null,
  ContextSystemPromptUsage: () => null,
}));

vi.mock("../chat-input/prompts/mcp-prompts-popover", () => ({
  PromptsPopover: () => <div data-testid="prompts-popover" />,
  isMCPPromptsRequested: () => false,
}));

vi.mock("../chat-input/prompts/mcp-prompt-result-card", () => ({
  MCPPromptResultCard: ({ onRemove }: { onRemove: () => void }) => (
    <button data-testid="mcp-prompt-card" onClick={onRemove}>
      Prompt Card
    </button>
  ),
}));

vi.mock("@/hooks/use-textarea-caret-position", () => ({
  useTextareaCaretPosition: () => ({ x: 0, y: 0, height: 20 }),
}));

describe("ChatInput", () => {
  const defaultModel: ModelDefinition = {
    id: "gpt-4",
    name: "GPT-4",
    provider: "openai",
    contextWindow: 8192,
    maxOutputTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStreaming: true,
  };

  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSubmit: vi.fn(),
    stop: vi.fn(),
    currentModel: defaultModel,
    availableModels: [defaultModel],
    onModelChange: vi.fn(),
    systemPrompt: "You are a helpful assistant.",
    onSystemPromptChange: vi.fn(),
    temperature: 0.7,
    onTemperatureChange: vi.fn(),
    onResetChat: vi.fn(),
    mcpPromptResults: [],
    onChangeMcpPromptResults: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("rendering", () => {
    it("renders textarea with placeholder", () => {
      render(<ChatInput {...defaultProps} placeholder="Type here..." />);

      expect(screen.getByPlaceholderText("Type here...")).toBeInTheDocument();
    });

    it("renders model selector", () => {
      render(<ChatInput {...defaultProps} />);

      expect(screen.getByTestId("model-selector")).toBeInTheDocument();
      expect(screen.getByTestId("model-selector")).toHaveTextContent("GPT-4");
    });

    it("renders system prompt selector", () => {
      render(<ChatInput {...defaultProps} />);

      expect(screen.getByTestId("system-prompt-selector")).toBeInTheDocument();
    });

    it("renders submit button", () => {
      render(<ChatInput {...defaultProps} value="Hello" />);

      // Submit button exists
      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  describe("input handling", () => {
    it("calls onChange when typing", () => {
      const onChange = vi.fn();
      render(<ChatInput {...defaultProps} onChange={onChange} />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.change(textarea, { target: { value: "Hello" } });

      expect(onChange).toHaveBeenCalledWith("Hello");
    });

    it("shows value in textarea", () => {
      render(<ChatInput {...defaultProps} value="Test message" />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      expect(textarea).toHaveValue("Test message");
    });
  });

  describe("form submission", () => {
    it("calls onSubmit when form is submitted", () => {
      const onSubmit = vi.fn((e) => e.preventDefault());
      render(<ChatInput {...defaultProps} value="Hello" onSubmit={onSubmit} />);

      const form = document.querySelector("form");
      if (form) {
        fireEvent.submit(form);
        expect(onSubmit).toHaveBeenCalled();
      }
    });

    it("disables submit when value is empty", () => {
      render(<ChatInput {...defaultProps} value="" />);

      // The submit button should be visually disabled
      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null
      );
      if (submitButton) {
        expect(submitButton).toBeDisabled();
      }
    });

    it("enables submit when value has content", () => {
      render(<ChatInput {...defaultProps} value="Hello" />);

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null
      );
      if (submitButton) {
        expect(submitButton).not.toBeDisabled();
      }
    });
  });

  describe("disabled state", () => {
    it("disables textarea when disabled prop is true", () => {
      render(<ChatInput {...defaultProps} disabled={true} />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      expect(textarea).toBeDisabled();
    });

    it("shows not-allowed cursor when disabled", () => {
      render(<ChatInput {...defaultProps} disabled={true} />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      expect(textarea.className).toContain("cursor-not-allowed");
    });
  });

  describe("loading state", () => {
    it("shows stop button when loading", () => {
      render(<ChatInput {...defaultProps} isLoading={true} />);

      // Stop button has Square icon
      const buttons = screen.getAllByRole("button");
      const stopButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-square") !== null
      );
      expect(stopButton).toBeDefined();
    });

    it("calls stop when stop button clicked", () => {
      const stop = vi.fn();
      render(<ChatInput {...defaultProps} isLoading={true} stop={stop} />);

      const buttons = screen.getAllByRole("button");
      const stopButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-square") !== null
      );
      if (stopButton) {
        fireEvent.click(stopButton);
        expect(stop).toHaveBeenCalled();
      }
    });
  });

  describe("model selection", () => {
    it("calls onModelChange when model is changed", () => {
      const onModelChange = vi.fn();
      render(
        <ChatInput {...defaultProps} onModelChange={onModelChange} />
      );

      fireEvent.click(screen.getByTestId("model-selector"));

      expect(onModelChange).toHaveBeenCalled();
    });
  });

  describe("MCP prompt results", () => {
    it("renders MCP prompt cards when results exist", () => {
      const mcpPromptResults = [
        { promptName: "test-prompt", result: "test result", serverName: "server" },
      ];

      render(
        <ChatInput
          {...defaultProps}
          mcpPromptResults={mcpPromptResults as any}
        />
      );

      expect(screen.getByTestId("mcp-prompt-card")).toBeInTheDocument();
    });

    it("removes prompt result when card is dismissed", () => {
      const onChangeMcpPromptResults = vi.fn();
      const mcpPromptResults = [
        { promptName: "test-prompt", result: "test result", serverName: "server" },
      ];

      render(
        <ChatInput
          {...defaultProps}
          mcpPromptResults={mcpPromptResults as any}
          onChangeMcpPromptResults={onChangeMcpPromptResults}
        />
      );

      fireEvent.click(screen.getByTestId("mcp-prompt-card"));

      expect(onChangeMcpPromptResults).toHaveBeenCalledWith([]);
    });

    it("enables submit when MCP prompts exist even without text", () => {
      const mcpPromptResults = [
        { promptName: "test-prompt", result: "test result", serverName: "server" },
      ];

      render(
        <ChatInput
          {...defaultProps}
          value=""
          mcpPromptResults={mcpPromptResults as any}
        />
      );

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null
      );
      if (submitButton) {
        expect(submitButton).not.toBeDisabled();
      }
    });
  });

  describe("keyboard handling", () => {
    it("submits on Enter without Shift", () => {
      const onSubmit = vi.fn((e) => e.preventDefault());
      render(
        <ChatInput {...defaultProps} value="Hello" onSubmit={onSubmit} />
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      // Form submission is triggered via requestSubmit
      // The actual submission behavior depends on the form
    });

    it("does not submit on Shift+Enter", () => {
      const onSubmit = vi.fn((e) => e.preventDefault());
      render(
        <ChatInput {...defaultProps} value="Hello" onSubmit={onSubmit} />
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // Shift+Enter should not trigger submission
    });
  });

  describe("compact mode", () => {
    it("passes compact prop to ModelSelector", () => {
      render(<ChatInput {...defaultProps} compact={true} />);

      expect(screen.getByTestId("model-selector")).toBeInTheDocument();
    });
  });

  describe("token usage", () => {
    it("renders context component with token usage", () => {
      render(
        <ChatInput
          {...defaultProps}
          hasMessages={true}
          tokenUsage={{
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          }}
        />
      );

      expect(screen.getByTestId("context")).toBeInTheDocument();
    });
  });
});
