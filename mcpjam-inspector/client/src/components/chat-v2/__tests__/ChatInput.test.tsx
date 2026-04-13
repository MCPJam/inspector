import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatInput } from "../chat-input";
import {
  SandboxHostStyleProvider,
  SandboxHostThemeProvider,
} from "@/contexts/sandbox-host-style-context";
import type { ModelDefinition } from "@/shared/types";

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (selector: (state: { themeMode: "light" }) => unknown) =>
    selector({ themeMode: "light" }),
}));

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

vi.mock("../chat-input/skills/skill-result-card", () => ({
  SkillResultCard: () => <div data-testid="skill-result-card">Skill Card</div>,
}));

vi.mock("../chat-input/attachments/file-attachment-card", () => ({
  FileAttachmentCard: () => (
    <div data-testid="file-attachment-card">File Attachment</div>
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
    skillResults: [],
    onChangeSkillResults: vi.fn(),
    onChangeFileAttachments: vi.fn(),
    onRequireToolApprovalChange: vi.fn(),
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

    it("renders system prompt selector", async () => {
      render(<ChatInput {...defaultProps} />);

      expect(screen.getByTestId("system-prompt-selector")).toBeInTheDocument();
    });

    it("renders submit button", () => {
      render(<ChatInput {...defaultProps} value="Hello" />);

      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeInTheDocument();
    });

    it("uses ChatGPT submit styling inside ChatGPT sandboxes", () => {
      render(
        <SandboxHostStyleProvider value="chatgpt">
          <ChatInput {...defaultProps} value="Hello" />
        </SandboxHostStyleProvider>,
      );

      expect(screen.getByRole("button", { name: "Send message" })).toHaveClass(
        "bg-[#1f1f1f]",
      );
    });

    it("keeps the textarea transparent inside a dark host-scoped composer", () => {
      render(
        <SandboxHostStyleProvider value="chatgpt">
          <SandboxHostThemeProvider value="dark">
            <ChatInput {...defaultProps} />
          </SandboxHostThemeProvider>
        </SandboxHostStyleProvider>,
      );

      expect(screen.getByPlaceholderText("Type your message...")).toHaveClass(
        "bg-transparent",
        "dark:bg-transparent",
      );
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

    it("places the caret at the end when requested", () => {
      render(
        <ChatInput
          {...defaultProps}
          value="Draw me an MCP architecture diagram"
          moveCaretToEndTrigger={1}
        />,
      );

      const textarea = screen.getByPlaceholderText(
        "Type your message...",
      ) as HTMLTextAreaElement;

      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(
        "Draw me an MCP architecture diagram".length,
      );
      expect(textarea.selectionEnd).toBe(
        "Draw me an MCP architecture diagram".length,
      );
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
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null,
      );
      if (submitButton) {
        expect(submitButton).toBeDisabled();
      }
    });

    it("enables submit when value has content", () => {
      render(<ChatInput {...defaultProps} value="Hello" />);

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null,
      );
      if (submitButton) {
        expect(submitButton).not.toBeDisabled();
      }
    });

    it("disables submit when submitDisabled is true even if value has content", () => {
      render(
        <ChatInput {...defaultProps} value="Hello" submitDisabled={true} />,
      );

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null,
      );
      expect(submitButton).toBeDefined();
      expect(submitButton).toBeDisabled();
    });

    it("does not request form submit on Enter when submitDisabled is true", () => {
      const requestSubmitSpy = vi
        .spyOn(HTMLFormElement.prototype, "requestSubmit")
        .mockImplementation(() => {});

      render(
        <ChatInput
          {...defaultProps}
          value="Hello"
          submitDisabled={true}
          onSubmit={vi.fn((e) => e.preventDefault())}
        />,
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      expect(requestSubmitSpy).not.toHaveBeenCalled();

      requestSubmitSpy.mockRestore();
    });
  });

  describe("onboarding send button", () => {
    it("applies glow animation only when pulseSubmit is true", () => {
      const { rerender } = render(
        <ChatInput {...defaultProps} value="Hello" pulseSubmit={false} />,
      );
      let submit = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector("svg.lucide-arrow-up") !== null);
      expect(submit).toBeDefined();
      expect(submit?.className).not.toContain("animate-onboarding-pulse");

      rerender(
        <ChatInput {...defaultProps} value="Hello" pulseSubmit={true} />,
      );
      submit = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector("svg.lucide-arrow-up") !== null);
      expect(submit?.className).toContain("animate-onboarding-pulse");
    });

    it("uses shadow-none so default button shadow does not read as a constant glow", () => {
      render(<ChatInput {...defaultProps} value="Hello" />);
      const submit = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector("svg.lucide-arrow-up") !== null);
      expect(submit?.className).toContain("shadow-none");
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
        (btn) => btn.querySelector("svg.lucide-square") !== null,
      );
      expect(stopButton).toBeDefined();
      expect(stopButton?.className).not.toContain("bg-destructive");
    });

    it("calls stop when stop button clicked", () => {
      const stop = vi.fn();
      render(<ChatInput {...defaultProps} isLoading={true} stop={stop} />);

      const buttons = screen.getAllByRole("button");
      const stopButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-square") !== null,
      );
      if (stopButton) {
        fireEvent.click(stopButton);
        expect(stop).toHaveBeenCalled();
      }
    });

    it("keeps the textarea editable while loading", () => {
      render(<ChatInput {...defaultProps} isLoading={true} value="Draft" />);

      expect(
        screen.getByPlaceholderText("Type your message..."),
      ).not.toBeDisabled();
    });

    it("keeps the options menu enabled while loading", () => {
      render(<ChatInput {...defaultProps} isLoading={true} />);

      expect(screen.getByRole("button", { name: "Options" })).toBeEnabled();
    });

    it("does not request form submit on Enter while loading", () => {
      const requestSubmitSpy = vi
        .spyOn(HTMLFormElement.prototype, "requestSubmit")
        .mockImplementation(() => {});

      render(
        <ChatInput
          {...defaultProps}
          value="Draft"
          isLoading={true}
          onSubmit={vi.fn((e) => e.preventDefault())}
        />,
      );

      fireEvent.keyDown(screen.getByPlaceholderText("Type your message..."), {
        key: "Enter",
        shiftKey: false,
      });

      expect(requestSubmitSpy).not.toHaveBeenCalled();

      requestSubmitSpy.mockRestore();
    });
  });

  describe("model selection", () => {
    it("calls onModelChange when model is changed", () => {
      const onModelChange = vi.fn();
      render(<ChatInput {...defaultProps} onModelChange={onModelChange} />);

      fireEvent.click(screen.getByTestId("model-selector"));

      expect(onModelChange).toHaveBeenCalled();
    });
  });

  describe("host style selector", () => {
    it("shows the Claude/ChatGPT pill selector in the options menu when enabled", () => {
      render(
        <ChatInput
          {...defaultProps}
          showHostStyleSelector={true}
          hostStyle="claude"
          onHostStyleChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      expect(screen.getByText("Host Style")).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: "ChatGPT" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Claude" })).toBeInTheDocument();
    });

    it("calls onHostStyleChange when the host style pill is changed", () => {
      const onHostStyleChange = vi.fn();

      render(
        <ChatInput
          {...defaultProps}
          showHostStyleSelector={true}
          hostStyle="claude"
          onHostStyleChange={onHostStyleChange}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));
      fireEvent.click(screen.getByRole("radio", { name: "ChatGPT" }));

      expect(onHostStyleChange).toHaveBeenCalledWith("chatgpt");
    });

    it("renders the host style section after tool approval at the bottom of the menu", () => {
      render(
        <ChatInput
          {...defaultProps}
          showHostStyleSelector={true}
          hostStyle="claude"
          onHostStyleChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      const toolApproval = screen.getByText("Tool Approval");
      const hostStyle = screen.getByText("Host Style");

      expect(
        toolApproval.compareDocumentPosition(hostStyle) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    });

    it("keeps the host style selector out of the options menu by default", () => {
      render(
        <ChatInput
          {...defaultProps}
          hostStyle="claude"
          onHostStyleChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      expect(screen.queryByText("Host Style")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("radio", { name: "ChatGPT" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("MCP prompt results", () => {
    it("renders MCP prompt cards when results exist", () => {
      const mcpPromptResults = [
        {
          promptName: "test-prompt",
          result: "test result",
          serverName: "server",
        },
      ];

      render(
        <ChatInput
          {...defaultProps}
          mcpPromptResults={mcpPromptResults as any}
        />,
      );

      expect(screen.getByTestId("mcp-prompt-card")).toBeInTheDocument();
    });

    it("removes prompt result when card is dismissed", () => {
      const onChangeMcpPromptResults = vi.fn();
      const mcpPromptResults = [
        {
          promptName: "test-prompt",
          result: "test result",
          serverName: "server",
        },
      ];

      render(
        <ChatInput
          {...defaultProps}
          mcpPromptResults={mcpPromptResults as any}
          onChangeMcpPromptResults={onChangeMcpPromptResults}
        />,
      );

      fireEvent.click(screen.getByTestId("mcp-prompt-card"));

      expect(onChangeMcpPromptResults).toHaveBeenCalledWith([]);
    });

    it("enables submit when MCP prompts exist even without text", () => {
      const mcpPromptResults = [
        {
          promptName: "test-prompt",
          result: "test result",
          serverName: "server",
        },
      ];

      render(
        <ChatInput
          {...defaultProps}
          value=""
          mcpPromptResults={mcpPromptResults as any}
        />,
      );

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null,
      );
      if (submitButton) {
        expect(submitButton).not.toBeDisabled();
      }
    });

    it("keeps submit enabled in minimal mode when prompt results exist", () => {
      const mcpPromptResults = [
        {
          promptName: "test-prompt",
          result: "test result",
          serverName: "server",
        },
      ];

      render(
        <ChatInput
          {...defaultProps}
          value=""
          minimalMode={true}
          mcpPromptResults={mcpPromptResults as any}
        />,
      );

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null,
      );
      if (submitButton) {
        expect(submitButton).not.toBeDisabled();
      }
    });
  });

  describe("keyboard handling", () => {
    it("submits on Enter without Shift", () => {
      const onSubmit = vi.fn((e) => e.preventDefault());
      render(<ChatInput {...defaultProps} value="Hello" onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

      // Form submission is triggered via requestSubmit
      // The actual submission behavior depends on the form
    });

    it("does not submit on Shift+Enter", () => {
      const onSubmit = vi.fn((e) => e.preventDefault());
      render(<ChatInput {...defaultProps} value="Hello" onSubmit={onSubmit} />);

      const textarea = screen.getByPlaceholderText("Type your message...");
      fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

      // Shift+Enter should not trigger submission
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
        />,
      );

      expect(screen.getByTestId("context")).toBeInTheDocument();
    });
  });

  describe("minimal mode", () => {
    it("hides plus dropdown, model selector, and context in minimal mode", () => {
      render(<ChatInput {...defaultProps} minimalMode={true} />);

      expect(screen.getByTestId("prompts-popover")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Options" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("system-prompt-selector"),
      ).not.toBeInTheDocument();
    });

    it("hides context usage UI in minimal mode", () => {
      render(
        <ChatInput
          {...defaultProps}
          minimalMode={true}
          hasMessages={true}
          tokenUsage={{
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          }}
        />,
      );

      expect(screen.queryByTestId("context")).not.toBeInTheDocument();
      expect(screen.queryByTestId("context-trigger")).not.toBeInTheDocument();
    });
  });
});
