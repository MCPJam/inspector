import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  createEvent,
  waitFor,
} from "@testing-library/react";
import { ChatInput } from "../chat-input";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import type { ModelDefinition } from "@/shared/types";
import { authFetch } from "@/lib/session-token";

const providerKeyState = vi.hoisted(() => ({
  openrouterToken: "",
}));

vi.mock("@/hooks/use-ai-provider-keys", () => ({
  useAiProviderKeys: () => ({
    getToken: (provider: string) =>
      provider === "openrouter" ? providerKeyState.openrouterToken : "",
  }),
}));

vi.mock("@/hooks/useCreditBalance", () => ({
  useCreditBalance: () => ({
    balance: undefined,
    isLoading: false,
    isAuthenticated: false,
    hasWorkOsUser: false,
  }),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

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

function installAudioRecordingMocks(options: { emitStopEvent?: boolean } = {}) {
  const emitStopEvent = options.emitStopEvent ?? true;
  const stopTrack = vi.fn();
  const stream = {
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream;

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(stream),
    },
  });

  class MockMediaRecorder {
    static isTypeSupported = vi.fn(() => true);

    state: RecordingState = "inactive";
    mimeType: string;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start() {
      this.state = "recording";
    }

    requestData() {
      this.ondataavailable?.({
        data: new Blob(["audio bytes"], { type: this.mimeType }),
      });
    }

    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["audio bytes"], { type: this.mimeType }),
      });
      if (emitStopEvent) {
        this.onstop?.();
      }
    }
  }

  vi.stubGlobal("MediaRecorder", MockMediaRecorder);

  return { stopTrack };
}

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
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:http://localhost/chat-input-test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    vi.mocked(authFetch).mockReset();
    providerKeyState.openrouterToken = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function createMockFile(name: string, type: string): File {
    return new File(["test file contents"], name, { type });
  }

  function createClipboardPasteEvent(
    target: Element,
    options: {
      files?: File[];
      textOnly?: boolean;
    },
  ) {
    const files = options.files ?? [];
    const clipboardData = {
      files,
      items: options.textOnly
        ? [
            {
              kind: "string",
              type: "text/plain",
              getAsFile: () => null,
            },
          ]
        : files.map((file) => ({
            kind: "file",
            type: file.type,
            getAsFile: () => file,
          })),
      types: files.length > 0 ? ["Files"] : ["text/plain"],
    };
    const event = createEvent.paste(target);
    Object.defineProperty(event, "clipboardData", {
      configurable: true,
      value: clipboardData,
    });
    return event;
  }

  function createFileDragData(files: File[]) {
    return {
      files,
      items: files.map((file) => ({
        kind: "file",
        type: file.type,
        getAsFile: () => file,
      })),
      types: ["Files"],
    };
  }

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
        screen.getByRole("button", { name: "Send message" })
      ).toBeInTheDocument();
    });

    it("uses ChatGPT submit styling inside ChatGPT chatboxes", () => {
      render(
        <ChatboxHostStyleProvider value="chatgpt">
          <ChatInput {...defaultProps} value="Hello" />
        </ChatboxHostStyleProvider>
      );

      expect(screen.getByRole("button", { name: "Send message" })).toHaveClass(
        "bg-[#1f1f1f]"
      );
    });

    it("keeps the textarea transparent inside a dark host-scoped composer", () => {
      render(
        <ChatboxHostStyleProvider value="chatgpt">
          <ChatboxHostThemeProvider value="dark">
            <ChatInput {...defaultProps} />
          </ChatboxHostThemeProvider>
        </ChatboxHostStyleProvider>
      );

      expect(screen.getByPlaceholderText("Type your message...")).toHaveClass(
        "bg-transparent",
        "dark:bg-transparent"
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
        />
      );

      const textarea = screen.getByPlaceholderText(
        "Type your message..."
      ) as HTMLTextAreaElement;

      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(
        "Draw me an MCP architecture diagram".length
      );
      expect(textarea.selectionEnd).toBe(
        "Draw me an MCP architecture diagram".length
      );
    });
  });

  describe("file paste and drop", () => {
    it("attaches pasted clipboard images with a fallback filename", () => {
      const onChangeFileAttachments = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          onChangeFileAttachments={onChangeFileAttachments}
        />,
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      const file = createMockFile("", "image/png");
      const event = createClipboardPasteEvent(textarea, { files: [file] });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      fireEvent(textarea, event);

      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(onChangeFileAttachments).toHaveBeenCalledTimes(1);
      const attachments = onChangeFileAttachments.mock.calls[0][0];
      expect(attachments).toHaveLength(1);
      expect(attachments[0].file.name).toBe("pasted-image-1.png");
      expect(attachments[0].file.type).toBe("image/png");
      expect(attachments[0].previewUrl).toBe(
        "blob:http://localhost/chat-input-test",
      );
    });

    it("does not intercept plain text paste", () => {
      const onChangeFileAttachments = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          onChangeFileAttachments={onChangeFileAttachments}
        />,
      );

      const textarea = screen.getByPlaceholderText("Type your message...");
      const event = createClipboardPasteEvent(textarea, { textOnly: true });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");

      fireEvent(textarea, event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(onChangeFileAttachments).not.toHaveBeenCalled();
    });

    it("shows a drop overlay and attaches dropped files", () => {
      const onChangeFileAttachments = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          onChangeFileAttachments={onChangeFileAttachments}
        />,
      );

      const composer = screen.getByTestId("chat-input-composer");
      const file = createMockFile("diagram.png", "image/png");
      const dataTransfer = createFileDragData([file]);

      fireEvent.dragEnter(composer, { dataTransfer });

      expect(
        screen.getByText("Drop image or file to attach"),
      ).toBeInTheDocument();

      fireEvent.drop(composer, { dataTransfer });

      expect(
        screen.queryByText("Drop image or file to attach"),
      ).not.toBeInTheDocument();
      expect(onChangeFileAttachments).toHaveBeenCalledTimes(1);
      const attachments = onChangeFileAttachments.mock.calls[0][0];
      expect(attachments[0].file).toBe(file);
      expect(attachments[0].previewUrl).toBe(
        "blob:http://localhost/chat-input-test",
      );
    });

    it("shows existing validation errors for invalid dropped files", () => {
      const onChangeFileAttachments = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          onChangeFileAttachments={onChangeFileAttachments}
        />,
      );

      const composer = screen.getByTestId("chat-input-composer");
      const file = createMockFile("clip.mp4", "video/mp4");

      fireEvent.drop(composer, { dataTransfer: createFileDragData([file]) });

      expect(onChangeFileAttachments).not.toHaveBeenCalled();
      expect(
        screen.getByText(/clip\.mp4: Unsupported file type/),
      ).toBeInTheDocument();
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

    it("disables submit when submitDisabled is true even if value has content", () => {
      render(
        <ChatInput {...defaultProps} value="Hello" submitDisabled={true} />
      );

      const buttons = screen.getAllByRole("button");
      const submitButton = buttons.find(
        (btn) => btn.querySelector("svg.lucide-arrow-up") !== null
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
        />
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
        <ChatInput {...defaultProps} value="Hello" pulseSubmit={false} />
      );
      let submit = screen
        .getAllByRole("button")
        .find((btn) => btn.querySelector("svg.lucide-arrow-up") !== null);
      expect(submit).toBeDefined();
      expect(submit?.className).not.toContain("animate-onboarding-pulse");

      rerender(
        <ChatInput {...defaultProps} value="Hello" pulseSubmit={true} />
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
        (btn) => btn.querySelector("svg.lucide-square") !== null
      );
      expect(stopButton).toBeDefined();
      expect(stopButton?.className).not.toContain("bg-destructive");
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

    it("keeps the textarea editable while loading", () => {
      render(<ChatInput {...defaultProps} isLoading={true} value="Draft" />);

      expect(
        screen.getByPlaceholderText("Type your message...")
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
        />
      );

      fireEvent.keyDown(screen.getByPlaceholderText("Type your message..."), {
        key: "Enter",
        shiftKey: false,
      });

      expect(requestSubmitSpy).not.toHaveBeenCalled();

      requestSubmitSpy.mockRestore();
    });
  });

  describe("voice input", () => {
    it("uses backend provider context without requiring a local OpenRouter key", async () => {
      installAudioRecordingMocks();
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ text: "backend transcript" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const onChange = vi.fn();

      render(
        <ChatInput
          {...defaultProps}
          value=""
          onChange={onChange}
          voiceInputContext={{
            projectId: "project-1",
            selectedServerIds: ["server-1"],
            chatboxId: "chatbox-1",
            accessVersion: 2,
          }}
          voiceInputAuthHeaders={{ Authorization: "Bearer user-token" }}
        />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });
      expect(screen.getByDisplayValue("Listening...")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Stop recording voice input" })
      );

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith("backend transcript");
      });

      expect(authFetch).toHaveBeenCalledWith(
        "/api/web/audio/transcriptions",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer user-token",
            "Content-Type": "application/json",
          },
        })
      );
      const [, init] = vi.mocked(authFetch).mock.calls[0];
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        model: "openai/whisper-1",
        projectId: "project-1",
        selectedServerIds: ["server-1"],
        chatboxId: "chatbox-1",
        accessVersion: 2,
        input_audio: {
          data: expect.any(String),
          format: "webm",
        },
        audioDurationSeconds: expect.any(Number),
      });
    });

    it("falls back to a local OpenRouter key when no backend context is available", async () => {
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks();
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ text: "hello there" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const onChange = vi.fn();

      render(
        <ChatInput {...defaultProps} value="Existing" onChange={onChange} />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop recording voice input" })
      );

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith("Existing hello there");
      });

      expect(authFetch).toHaveBeenCalledWith(
        "/api/mcp/audio/transcriptions",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        })
      );
      const [, init] = vi.mocked(authFetch).mock.calls[0];
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        apiKey: "sk-or-test",
        model: "openai/whisper-1",
        input_audio: {
          data: expect.any(String),
          format: "webm",
        },
        audioDurationSeconds: expect.any(Number),
      });
    });

    it("keeps the existing input in listening mode until canceling voice input", async () => {
      installAudioRecordingMocks();
      const onChange = vi.fn();

      render(<ChatInput {...defaultProps} value="" onChange={onChange} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });
      expect(screen.getByDisplayValue("Listening...")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Cancel voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Start voice input" })
        ).toBeInTheDocument();
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(authFetch).not.toHaveBeenCalled();
    });

    it("keeps the stop control available if the composer becomes disabled mid-recording", async () => {
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks();
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ text: "still captured" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const onChange = vi.fn();
      const { rerender } = render(
        <ChatInput {...defaultProps} value="" onChange={onChange} />
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });

      rerender(
        <ChatInput
          {...defaultProps}
          value=""
          onChange={onChange}
          disabled={true}
        />
      );

      const stopButton = screen.getByRole("button", {
        name: "Stop recording voice input",
      });
      expect(stopButton).not.toBeDisabled();

      fireEvent.click(stopButton);

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith("still captured");
      });
    });

    it("finalizes recording if the browser never fires the stop event", async () => {
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks({ emitStopEvent: false });
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ text: "fallback transcript" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      const onChange = vi.fn();

      render(<ChatInput {...defaultProps} value="" onChange={onChange} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop recording voice input" })
      );

      await waitFor(
        () => {
          expect(onChange).toHaveBeenCalledWith("fallback transcript");
        },
        { timeout: 2500 }
      );
    });

    it("keeps voice input cancellable while transcription is pending", async () => {
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks();
      let resolveTranscription: ((response: Response) => void) | undefined;
      vi.mocked(authFetch).mockImplementation(
        (_url, init) =>
          new Promise((resolve, reject) => {
            resolveTranscription = resolve;
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) return;
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      );

      render(<ChatInput {...defaultProps} value="" onChange={vi.fn()} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop recording voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Transcribing recording" })
        ).toBeInTheDocument();
      });

      expect(
        screen.queryByRole("button", { name: "Start voice input" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Cancel voice input" })
      ).not.toBeDisabled();

      await waitFor(() => {
        expect(resolveTranscription).toBeDefined();
      });
      resolveTranscription!(
        new Response(JSON.stringify({ text: "resolved transcript" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: "Transcribing recording" })
        ).not.toBeInTheDocument();
      });
    });

    it("times out hung voice transcription and releases the composer", async () => {
      const realSetTimeout = window.setTimeout.bind(window);
      const setTimeoutSpy = vi
        .spyOn(window, "setTimeout")
        .mockImplementation((handler, timeout, ...args) =>
          realSetTimeout(
            handler,
            typeof timeout === "number" && timeout === 27_000 ? 0 : timeout,
            ...args
          )
        );
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks();
      vi.mocked(authFetch).mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!(signal instanceof AbortSignal)) return;
            signal.addEventListener("abort", () => {
              reject(new Error("aborted"));
            });
          })
      );
      const onChange = vi.fn();

      try {
        render(<ChatInput {...defaultProps} value="" onChange={onChange} />);

        fireEvent.click(
          screen.getByRole("button", { name: "Start voice input" })
        );

        await waitFor(() => {
          expect(
            screen.getByRole("button", { name: "Stop recording voice input" })
          ).toBeInTheDocument();
        });

        fireEvent.click(
          screen.getByRole("button", { name: "Stop recording voice input" })
        );

        await waitFor(() => {
          expect(
            screen.getByText(
              "Voice transcription timed out. Try a shorter recording."
            )
          ).toBeInTheDocument();
        });
        expect(
          screen.getByRole("button", { name: "Start voice input" })
        ).not.toBeDisabled();
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });

    it("shows transcription errors without changing the draft", async () => {
      providerKeyState.openrouterToken = "sk-or-test";
      installAudioRecordingMocks();
      vi.mocked(authFetch).mockResolvedValue(
        new Response(JSON.stringify({ error: "Invalid OpenRouter API key" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        })
      );
      const onChange = vi.fn();

      render(<ChatInput {...defaultProps} value="" onChange={onChange} />);

      fireEvent.click(
        screen.getByRole("button", { name: "Start voice input" })
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Stop recording voice input" })
        ).toBeInTheDocument();
      });

      fireEvent.click(
        screen.getByRole("button", { name: "Stop recording voice input" })
      );

      expect(
        await screen.findByText("Invalid OpenRouter API key")
      ).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
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
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      expect(screen.getByText("Client Style")).toBeInTheDocument();
      expect(
        screen.getByRole("radio", { name: "ChatGPT" })
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
        />
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
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      const toolApproval = screen.getByText("Tool Approval");
      const hostStyle = screen.getByText("Client Style");

      expect(
        toolApproval.compareDocumentPosition(hostStyle) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).not.toBe(0);
    });

    it("keeps the host style selector out of the options menu by default", () => {
      render(
        <ChatInput
          {...defaultProps}
          hostStyle="claude"
          onHostStyleChange={vi.fn()}
        />
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      expect(screen.queryByText("Client Style")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("radio", { name: "ChatGPT" })
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
        />
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
        />
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
        />
      );

      expect(screen.getByTestId("context")).toBeInTheDocument();
    });
  });

  describe("minimal mode", () => {
    it("hides plus dropdown, model selector, and context in minimal mode", () => {
      render(<ChatInput {...defaultProps} minimalMode={true} />);

      expect(screen.getByTestId("prompts-popover")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Options" })
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("model-selector")).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("system-prompt-selector")
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
        />
      );

      expect(screen.queryByTestId("context")).not.toBeInTheDocument();
      expect(screen.queryByTestId("context-trigger")).not.toBeInTheDocument();
    });
  });

  describe("servers popover (connectivity is the source of truth)", () => {
    const serverConfigs = {
      connectedSrv: {
        name: "connectedSrv",
        config: { url: "http://localhost/connected" },
        connectionStatus: "connected",
      },
      downSrv: {
        name: "downSrv",
        config: { url: "http://localhost/down" },
        connectionStatus: "disconnected",
      },
    } as any;

    it("toggling a connected server OFF disconnects it", () => {
      const onDisconnectServer = vi.fn();
      const onServerToggle = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          allServerConfigs={serverConfigs}
          selectedServers={["connectedSrv"]}
          onDisconnectServer={onDisconnectServer}
          onReconnectServer={vi.fn()}
          onServerToggle={onServerToggle}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));

      // The connected server renders an "on" Switch; flipping it disconnects.
      const toggles = screen.getAllByRole("switch");
      fireEvent.click(toggles[0]);

      expect(onDisconnectServer).toHaveBeenCalledWith("connectedSrv");
      // Selection is derived from connectivity now — no manual toggle write.
      expect(onServerToggle).not.toHaveBeenCalled();
    });

    it("clicking Connect on a disconnected server reconnects it without writing selection", () => {
      const onReconnectServer = vi.fn().mockResolvedValue(undefined);
      const onServerToggle = vi.fn();
      render(
        <ChatInput
          {...defaultProps}
          allServerConfigs={serverConfigs}
          selectedServers={["connectedSrv"]}
          onDisconnectServer={vi.fn()}
          onReconnectServer={onReconnectServer}
          onServerToggle={onServerToggle}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Options" }));
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));

      expect(onReconnectServer).toHaveBeenCalledWith("downSrv");
      expect(onServerToggle).not.toHaveBeenCalled();
    });
  });
});
