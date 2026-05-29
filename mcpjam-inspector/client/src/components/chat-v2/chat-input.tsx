import {
  useRef,
  useState,
  useCallback,
  useLayoutEffect,
  useMemo,
  useEffect,
} from "react";
import { HOSTED_MODE } from "@/lib/config";
import type { SkillsSource } from "@/lib/apis/mcp-skills-api";
import type {
  ChangeEvent,
  ClipboardEvent,
  DragEvent,
  FormEvent,
  KeyboardEvent,
} from "react";
import { usePostHog } from "posthog-js/react";
import { cn } from "@/lib/chat-utils";
import { standardEventProps } from "@/lib/PosthogUtils";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PromptsPopover } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import {
  ArrowUp,
  Square,
  Paperclip,
  ShieldCheck,
  Plus,
  Settings2,
  Loader2,
  Mic,
  X,
} from "lucide-react";
import { Switch } from "@mcpjam/design-system/switch";
import { FileAttachmentCard } from "@/components/chat-v2/chat-input/attachments/file-attachment-card";
import {
  type FileAttachment,
  validateFile,
  createFileAttachment,
  revokeFileAttachmentUrls,
  getFileInputAccept,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import {
  ClientSelector,
  type ClientSelectorData,
} from "@/components/chat-v2/chat-input/client-selector";
import { ModelDefinition, ServerFormData } from "@/shared/types";
import { AddServerModal } from "@/components/connection/AddServerModal";
import type { ServerWithName } from "@/hooks/use-app-state";
import { SystemPromptSelector } from "@/components/chat-v2/chat-input/system-prompt-selector";
import { DEFAULT_SYSTEM_PROMPT } from "@/components/chat-v2/shared/chat-helpers";
import { useTextareaCaretPosition } from "@/hooks/use-textarea-caret-position";
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextInputUsage,
  ContextOutputUsage,
  ContextMCPServerUsage,
  ContextSystemPromptUsage,
} from "@/components/chat-v2/chat-input/context";
import {
  type MCPPromptResult,
  isMCPPromptsRequested,
} from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import { MCPPromptResultCard } from "@/components/chat-v2/chat-input/prompts/mcp-prompt-result-card";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import { SkillResultCard } from "@/components/chat-v2/chat-input/skills/skill-result-card";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { ClientStylePillSelector } from "@/components/shared/ClientStylePillSelector";
import {
  getChatboxHostFamily,
  type ChatboxHostStyle,
} from "@/lib/chatbox-client-style";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { useCreditBalance } from "@/hooks/useCreditBalance";
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";

const OPENROUTER_STT_MODEL = "openai/whisper-1";
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 25_000;
const VOICE_TRANSCRIPTION_GUARD_MS = VOICE_TRANSCRIPTION_TIMEOUT_MS + 2_000;
const VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE =
  "Voice transcription timed out. Try a shorter recording.";
const VOICE_TRANSCRIPTION_IN_PROGRESS_CODE = "voice_transcription_in_progress";
const VOICE_TRANSCRIPTION_IN_PROGRESS_MESSAGE =
  "Another voice message is still processing. Try again in a moment.";
const VOICE_GLOBAL_MAX_SECONDS = 180;
const VOICE_WARNING_THRESHOLD_SECONDS = 300;

function formatVoiceSeconds(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (remainder === 0) {
    return `${minutes} min`;
  }
  return `${minutes} min ${remainder}s`;
}

const SUPPORTED_RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

type VoiceInputState = "idle" | "recording" | "transcribing";

type TranscriptionAbortState = {
  controller: AbortController;
  reason: "timeout" | null;
};

type VoiceInputBackendContext = {
  projectId?: string | null;
  selectedServerIds?: string[];
  chatboxId?: string;
  accessVersion?: number;
};

function getPreferredRecordingMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;

  return SUPPORTED_RECORDING_MIME_TYPES.find((mimeType) =>
    MediaRecorder.isTypeSupported(mimeType)
  );
}

function getAudioFormatFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mp4")) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("mpeg")) return "mp3";
  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("flac")) return "flac";
  if (normalized.includes("aac")) return "aac";
  return "webm";
}

async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof blob.arrayBuffer !== "function") {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const [, base64 = ""] = result.split(",");
        resolve(base64);
      };
      reader.onerror = () =>
        reject(reader.error ?? new Error("Failed to read audio data."));
      reader.readAsDataURL(blob);
    });
  }

  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

function mergeTranscriptIntoDraft(draft: string, transcript: string): string {
  const trimmedTranscript = transcript.trim();
  if (!trimmedTranscript) return draft;
  if (!draft.trim()) return trimmedTranscript;
  if (/\s$/.test(draft)) return `${draft}${trimmedTranscript}`;
  return `${draft} ${trimmedTranscript}`;
}

type AttachmentInputSource = "picker" | "paste" | "drop";

const FILE_TRANSFER_TYPE = "Files";
const DROP_OVERLAY_TEXT = "Drop image or file to attach";

function hasFileTransfer(types: DataTransfer["types"] | readonly string[]) {
  return Array.from(types).includes(FILE_TRANSFER_TYPE);
}

function getExtensionForMediaType(mediaType: string): string {
  const extensionByMediaType: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
    "text/csv": "csv",
  };

  return extensionByMediaType[mediaType] ?? "bin";
}

function normalizeIncomingFile(
  file: File,
  source: AttachmentInputSource,
  index: number,
): File {
  if (source !== "paste" || file.name.trim().length > 0) {
    return file;
  }

  const isImage = file.type.startsWith("image/");
  const prefix = isImage ? "pasted-image" : "pasted-file";
  const extension = getExtensionForMediaType(file.type);

  return new File([file], `${prefix}-${index + 1}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

function getFilesFromClipboardData(dataTransfer: DataTransfer): File[] {
  const filesFromItems = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (filesFromItems.length > 0) {
    return filesFromItems;
  }

  return Array.from(dataTransfer.files);
}

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    additionalInput?: string
  ) => void;
  stop: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  onModelSelectorOpenChange?: (open: boolean) => void;
  multiModelEnabled?: boolean;
  selectedModels?: ModelDefinition[];
  onSelectedModelsChange?: (models: ModelDefinition[]) => void;
  onMultiModelEnabledChange?: (enabled: boolean) => void;
  enableMultiModel?: boolean;
  /** Playground-only: renders a client chip beside the model chip. */
  clientSelector?: ClientSelectorData;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  temperature: number;
  onTemperatureChange: (temperature: number) => void;
  hasMessages?: boolean;
  onResetChat: () => void;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  selectedServers?: string[];
  mcpToolsTokenCount?: Record<string, number> | null;
  mcpToolsTokenCountLoading?: boolean;
  connectedOrConnectingServerConfigs?: Record<string, { name: string }>;
  systemPromptTokenCount?: number | null;
  systemPromptTokenCountLoading?: boolean;
  mcpPromptResults: MCPPromptResult[];
  onChangeMcpPromptResults: (mcpPromptResults: MCPPromptResult[]) => void;
  skillResults: SkillResult[];
  onChangeSkillResults: (skillResults: SkillResult[]) => void;
  /** File attachments for the message */
  fileAttachments?: FileAttachment[];
  /** Callback when file attachments change */
  onChangeFileAttachments?: (files: FileAttachment[]) => void;
  /** Tool approval toggle */
  requireToolApproval?: boolean;
  onRequireToolApprovalChange?: (enabled: boolean) => void;
  /** Shared chat-only mode */
  minimalMode?: boolean;
  /** Main chat: show the Claude/ChatGPT host-style selector in the "+" menu. */
  showHostStyleSelector?: boolean;
  /** Current host style for the selector UI. */
  hostStyle?: ChatboxHostStyle;
  /** Shared host-style setter. */
  onHostStyleChange?: (hostStyle: ChatboxHostStyle) => void;
  /** Onboarding: pulse the send button with glow animation */
  pulseSubmit?: boolean;
  /** Move the textarea caret to the end when this trigger changes */
  moveCaretToEndTrigger?: number;
  /** All project servers for the "+" dropdown server toggles. */
  allServerConfigs?: Record<string, ServerWithName>;
  /**
   * @deprecated Connectivity is now the single source of truth — the popover
   * toggle connects/disconnects via `onDisconnectServer`/`onReconnectServer`
   * rather than maintaining a separate per-chat selection. Kept so existing
   * callers compile; no longer read here.
   */
  onServerToggle?: (serverName: string) => void;
  /** Reconnect a disconnected server. */
  onReconnectServer?: (serverName: string) => Promise<void>;
  /**
   * Disconnect a connected server. Connectivity is the single source of
   * truth for which servers the Playground uses, so toggling a server off
   * here unplugs it (it stays in the list as a "Connect" row).
   */
  onDisconnectServer?: (serverName: string) => void;
  /** Add a new server (opens the add-server modal). */
  onAddServer?: (formData: ServerFormData) => void;
  /** Server-side provider context used to resolve the OpenRouter STT key. */
  voiceInputContext?: VoiceInputBackendContext;
  /** WorkOS/guest bearer used by local inspector routes to resolve provider keys. */
  voiceInputAuthHeaders?: Record<string, string>;
  /** Hosted chatbox: optional servers not yet connected (Add server popover). */
  chatboxAttachableServers?: Array<{
    serverId: string;
    serverName: string;
    useOAuth: boolean;
  }>;
  onAttachChatboxServer?: (serverId: string) => void;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  stop,
  disabled = false,
  submitDisabled = false,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  currentModel,
  availableModels,
  onModelChange,
  onModelSelectorOpenChange,
  multiModelEnabled = false,
  selectedModels,
  onSelectedModelsChange,
  onMultiModelEnabledChange,
  enableMultiModel = false,
  clientSelector,
  systemPrompt,
  onSystemPromptChange,
  temperature,
  onTemperatureChange,
  onResetChat,
  hasMessages = false,
  tokenUsage,
  selectedServers,
  mcpToolsTokenCount,
  mcpToolsTokenCountLoading = false,
  connectedOrConnectingServerConfigs,
  systemPromptTokenCount,
  systemPromptTokenCountLoading = false,
  mcpPromptResults,
  onChangeMcpPromptResults,
  skillResults,
  onChangeSkillResults,
  fileAttachments = [],
  onChangeFileAttachments,
  requireToolApproval = false,
  onRequireToolApprovalChange,
  minimalMode = false,
  showHostStyleSelector = false,
  hostStyle,
  onHostStyleChange,
  pulseSubmit = false,
  moveCaretToEndTrigger,
  allServerConfigs,
  onReconnectServer,
  onDisconnectServer,
  onAddServer,
  voiceInputContext,
  voiceInputAuthHeaders,
  chatboxAttachableServers,
  onAttachChatboxServer,
}: ChatInputProps) {
  // Cloud skill source for the `/` picker: in hosted mode, list/load skills
  // from the project's Convex/Computer source (Playground carries projectId via
  // `clientSelector`). Local mode keeps the default (filesystem) path. Memoized
  // so the popover's fetch effects don't re-run every render.
  const skillsSource = useMemo<SkillsSource | undefined>(
    () =>
      HOSTED_MODE && clientSelector?.cloudProjectId
        ? { kind: "cloud", projectId: clientSelector.cloudProjectId }
        : undefined,
    [clientSelector?.cloudProjectId],
  );
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const globalThemeMode = usePreferencesStore((s) => s.themeMode);
  const resolvedThemeMode = chatboxHostTheme ?? globalThemeMode;
  const isDarkChatboxTheme = resolvedThemeMode === "dark";
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const recordedAudioChunksRef = useRef<Blob[]>([]);
  const recordingMimeTypeRef = useRef("audio/webm");
  const recordingFinalizedRef = useRef(false);
  const stopFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const recordingCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const recordingStartedAtRef = useRef<number | null>(null);
  const recordingDurationSecondsRef = useRef<number>(0);
  const transcriptionRunRef = useRef(0);
  const transcriptionAbortRef = useRef<TranscriptionAbortState | null>(null);
  const mountedRef = useRef(true);
  const valueRef = useRef(value);
  const [caretIndex, setCaretIndex] = useState(0);
  const [mcpPromptPopoverKeyTrigger, setMcpPromptPopoverKeyTrigger] = useState<
    string | null
  >(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileDragDepth, setFileDragDepth] = useState(0);
  const [voiceInputState, setVoiceInputState] =
    useState<VoiceInputState>("idle");
  const [voiceInputError, setVoiceInputError] = useState<string | null>(null);
  const posthog = usePostHog();
  const { getToken } = useAiProviderKeys();
  const localOpenRouterApiKey = getToken("openrouter").trim();
  const { balance: creditBalance } = useCreditBalance({ includeGuests: true });
  // Track voice budget whenever the hosted backend enforces one — that's
  // any HOSTED_MODE session (including unauthenticated guests, who have a
  // daily quota) and any local session wired to a project. Local users with
  // their own OpenRouter key pay directly and aren't tracked here.
  const voiceBudgetTracked =
    HOSTED_MODE || Boolean(voiceInputContext?.projectId);
  const voiceSecondsRemaining =
    voiceBudgetTracked && creditBalance
      ? creditBalance.voiceSecondsRemaining
      : null;
  const voiceRecordingCapSeconds =
    voiceSecondsRemaining == null
      ? VOICE_GLOBAL_MAX_SECONDS
      : Math.min(VOICE_GLOBAL_MAX_SECONDS, voiceSecondsRemaining);
  const voiceBudgetWarning =
    voiceSecondsRemaining != null &&
    voiceSecondsRemaining > 0 &&
    voiceSecondsRemaining < VOICE_WARNING_THRESHOLD_SECONDS
      ? `You have about ${formatVoiceSeconds(
          voiceSecondsRemaining
        )} of voice left today — recording will stop automatically.`
      : null;
  const voiceBudgetExhausted =
    voiceSecondsRemaining != null && voiceSecondsRemaining <= 0;
  const [plusPopoverOpen, setPlusPopoverOpen] = useState(false);
  const handlePlusPopoverOpenChange = (nextOpen: boolean) => {
    if (nextOpen && !plusPopoverOpen) {
      posthog.capture(
        "chat_options_plus_clicked",
        standardEventProps("chat_input")
      );
    }
    setPlusPopoverOpen(nextOpen);
  };
  const [addServerModalOpen, setAddServerModalOpen] = useState(false);
  const [systemPromptOpen, setSystemPromptOpen] = useState(false);
  const selectorHostStyle = hostStyle ?? chatboxHostStyle;
  const hasServerRows = Boolean(
    allServerConfigs &&
    onDisconnectServer &&
    Object.keys(allServerConfigs).length > 0,
  );
  const hasServerOptions = Boolean(onAddServer || hasServerRows);
  const showHostStyleSelectorControl =
    showHostStyleSelector &&
    Boolean(selectorHostStyle) &&
    Boolean(onHostStyleChange);

  const caret = useTextareaCaretPosition(
    textareaRef,
    containerRef,
    value,
    caretIndex
  );

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const stopAudioStream = useCallback(() => {
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
  }, []);

  const clearStopFallbackTimer = useCallback(() => {
    if (!stopFallbackTimerRef.current) return;
    clearTimeout(stopFallbackTimerRef.current);
    stopFallbackTimerRef.current = null;
  }, []);

  const clearRecordingCapTimer = useCallback(() => {
    if (!recordingCapTimerRef.current) return;
    clearTimeout(recordingCapTimerRef.current);
    recordingCapTimerRef.current = null;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearStopFallbackTimer();
      clearRecordingCapTimer();
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      transcriptionAbortRef.current?.controller.abort();
      transcriptionAbortRef.current = null;
      stopAudioStream();
    };
  }, [clearRecordingCapTimer, clearStopFallbackTimer, stopAudioStream]);

  useLayoutEffect(() => {
    if (moveCaretToEndTrigger === undefined) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
    setCaretIndex(end);
  }, [moveCaretToEndTrigger]);

  const onMCPPromptSelected = useCallback(
    (mcpPromptResult: MCPPromptResult) => {
      // Add the prompt result to the mcpPromptResults state
      onChangeMcpPromptResults([...mcpPromptResults, mcpPromptResult]);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);
    },
    [value, caretIndex, onChange, mcpPromptResults, onChangeMcpPromptResults]
  );

  const removeMCPPromptResult = (index: number) => {
    onChangeMcpPromptResults(mcpPromptResults.filter((_, i) => i !== index));
  };

  const canHandleFileTransfers = Boolean(onChangeFileAttachments);
  const canAttachFiles = canHandleFileTransfers && !disabled;
  const isFileDragActive = fileDragDepth > 0;

  // File attachment handlers
  const addFileAttachments = useCallback(
    (files: Iterable<File>, source: AttachmentInputSource) => {
      if (!onChangeFileAttachments) return false;

      const incomingFiles = Array.from(files).map((file, index) =>
        normalizeIncomingFile(file, source, index),
      );
      if (incomingFiles.length === 0) return false;

      setFileError(null);
      const newAttachments: FileAttachment[] = [];
      const errors: string[] = [];

      for (const file of incomingFiles) {
        const validation = validateFile(file);

        if (validation.valid) {
          newAttachments.push(createFileAttachment(file));
        } else {
          errors.push(`${file.name}: ${validation.error}`);
        }
      }

      if (newAttachments.length > 0) {
        onChangeFileAttachments([...fileAttachments, ...newAttachments]);
      }

      if (errors.length > 0) {
        setFileError(errors.join("\n"));
        // Clear error after 5 seconds
        setTimeout(() => setFileError(null), 5000);
      }

      return true;
    },
    [fileAttachments, onChangeFileAttachments],
  );

  const handleFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;

      addFileAttachments(Array.from(files), "picker");

      // Reset input so the same file can be selected again
      event.target.value = "";
    },
    [addFileAttachments],
  );

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!canAttachFiles) return;

      const files = getFilesFromClipboardData(event.clipboardData);
      if (files.length === 0) return;

      event.preventDefault();
      addFileAttachments(files, "paste");
      textareaRef.current?.focus();
    },
    [addFileAttachments, canAttachFiles],
  );

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleFileTransfers || !hasFileTransfer(event.dataTransfer.types))
        return;

      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;

      setFileDragDepth((depth) => depth + 1);
    },
    [canHandleFileTransfers, disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleFileTransfers || !hasFileTransfer(event.dataTransfer.types))
        return;

      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    },
    [canHandleFileTransfers, disabled],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleFileTransfers || !hasFileTransfer(event.dataTransfer.types))
        return;

      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;

      setFileDragDepth((depth) => Math.max(0, depth - 1));
    },
    [canHandleFileTransfers, disabled],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!canHandleFileTransfers || !hasFileTransfer(event.dataTransfer.types))
        return;

      event.preventDefault();
      event.stopPropagation();
      setFileDragDepth(0);
      if (disabled) return;

      addFileAttachments(Array.from(event.dataTransfer.files), "drop");
      textareaRef.current?.focus();
    },
    [addFileAttachments, canHandleFileTransfers, disabled],
  );

  const removeFileAttachment = useCallback(
    (id: string) => {
      if (!onChangeFileAttachments) return;

      const attachment = fileAttachments.find((a) => a.id === id);
      if (attachment) {
        revokeFileAttachmentUrls([attachment]);
      }

      onChangeFileAttachments(fileAttachments.filter((a) => a.id !== id));
    },
    [fileAttachments, onChangeFileAttachments]
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const commitTranscriptToDraft = useCallback(
    (transcript: string) => {
      const nextValue = mergeTranscriptIntoDraft(valueRef.current, transcript);
      if (nextValue === valueRef.current) return;

      onChange(nextValue);
      valueRef.current = nextValue;

      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        textarea.focus();
        const end = nextValue.length;
        textarea.setSelectionRange(end, end);
        setCaretIndex(end);
      });
    },
    [onChange]
  );

  const transcribeAudio = useCallback(
    async (audioBlob: Blob): Promise<string> => {
      const abortState: TranscriptionAbortState = {
        controller: new AbortController(),
        reason: null,
      };
      transcriptionAbortRef.current = abortState;
      let timeoutId: number | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(() => {
          abortState.reason = "timeout";
          abortState.controller.abort();
          reject(new Error(VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE));
        }, VOICE_TRANSCRIPTION_TIMEOUT_MS);
      });

      const transcriptionRequest = (async () => {
        const base64Audio = await blobToBase64(audioBlob);
        if (abortState.controller.signal.aborted) {
          throw new Error(
            abortState.reason === "timeout"
              ? VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE
              : "Voice transcription was interrupted."
          );
        }

        const useBackendProviderKey = Boolean(voiceInputContext?.projectId);
        const transcriptionEndpoint = useBackendProviderKey
          ? "/api/web/audio/transcriptions"
          : HOSTED_MODE
          ? "/api/web/audio/transcriptions"
          : "/api/mcp/audio/transcriptions";
        const response = await authFetch(transcriptionEndpoint, {
          method: "POST",
          headers: {
            ...(HOSTED_MODE ? undefined : voiceInputAuthHeaders),
            "Content-Type": "application/json",
          },
          signal: abortState.controller.signal,
          body: JSON.stringify({
            ...(!useBackendProviderKey && localOpenRouterApiKey
              ? { apiKey: localOpenRouterApiKey }
              : {}),
            ...(voiceInputContext?.projectId
              ? { projectId: voiceInputContext.projectId }
              : {}),
            ...(voiceInputContext?.selectedServerIds &&
            voiceInputContext.selectedServerIds.length > 0
              ? { selectedServerIds: voiceInputContext.selectedServerIds }
              : {}),
            ...(voiceInputContext?.chatboxId
              ? { chatboxId: voiceInputContext.chatboxId }
              : {}),
            ...(voiceInputContext?.accessVersion !== undefined
              ? { accessVersion: voiceInputContext.accessVersion }
              : {}),
            model: OPENROUTER_STT_MODEL,
            input_audio: {
              data: base64Audio,
              format: getAudioFormatFromMimeType(audioBlob.type),
            },
            ...(recordingDurationSecondsRef.current > 0
              ? {
                  audioDurationSeconds: recordingDurationSecondsRef.current,
                }
              : {}),
          }),
        });

        const result = (await response.json().catch(() => null)) as {
          text?: unknown;
          error?: unknown;
          code?: unknown;
        } | null;

        if (!response.ok) {
          const message =
            result?.code === VOICE_TRANSCRIPTION_IN_PROGRESS_CODE
              ? VOICE_TRANSCRIPTION_IN_PROGRESS_MESSAGE
              : typeof result?.error === "string"
              ? result.error
              : "OpenRouter transcription failed";
          throw new Error(message);
        }

        if (!result || typeof result.text !== "string") {
          throw new Error("OpenRouter returned an empty transcription.");
        }

        return result.text;
      })();

      try {
        return await Promise.race([transcriptionRequest, timeoutPromise]);
      } catch (error) {
        if (abortState.controller.signal.aborted) {
          throw new Error(
            abortState.reason === "timeout"
              ? VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE
              : "Voice transcription was interrupted."
          );
        }
        throw error;
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
        if (transcriptionAbortRef.current === abortState) {
          transcriptionAbortRef.current = null;
        }
      }
    },
    [
      localOpenRouterApiKey,
      voiceInputAuthHeaders,
      voiceInputContext?.accessVersion,
      voiceInputContext?.chatboxId,
      voiceInputContext?.projectId,
      voiceInputContext?.selectedServerIds,
    ]
  );

  const handleRecordedAudio = useCallback(
    async (audioBlob: Blob): Promise<string> => {
      if (audioBlob.size === 0) {
        throw new Error("No audio was captured. Try recording again.");
      }

      return transcribeAudio(audioBlob);
    },
    [transcribeAudio]
  );

  const finalizeRecordedAudio = useCallback(
    (recorder?: MediaRecorder | null) => {
      if (recordingFinalizedRef.current) return;
      recordingFinalizedRef.current = true;
      clearStopFallbackTimer();

      if (recordingStartedAtRef.current != null) {
        recordingDurationSecondsRef.current = Math.max(
          0,
          (Date.now() - recordingStartedAtRef.current) / 1000
        );
        recordingStartedAtRef.current = null;
      }

      const chunks = recordedAudioChunksRef.current;
      recordedAudioChunksRef.current = [];
      stopAudioStream();

      if (!mountedRef.current) return;

      const audioBlob = new Blob(chunks, {
        type:
          recorder?.mimeType || recordingMimeTypeRef.current || "audio/webm",
      });

      setVoiceInputState("transcribing");
      const runId = transcriptionRunRef.current + 1;
      transcriptionRunRef.current = runId;
      const guardTimer = window.setTimeout(() => {
        if (!mountedRef.current || transcriptionRunRef.current !== runId) {
          return;
        }
        transcriptionRunRef.current += 1;
        transcriptionAbortRef.current?.controller.abort();
        transcriptionAbortRef.current = null;
        mediaRecorderRef.current = null;
        setVoiceInputError(VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE);
        setVoiceInputState("idle");
      }, VOICE_TRANSCRIPTION_GUARD_MS);

      handleRecordedAudio(audioBlob)
        .then((transcript) => {
          if (!mountedRef.current || transcriptionRunRef.current !== runId) {
            return;
          }
          commitTranscriptToDraft(transcript);
        })
        .catch((error) => {
          if (!mountedRef.current || transcriptionRunRef.current !== runId) {
            return;
          }
          setVoiceInputError(
            error instanceof Error
              ? error.message
              : "OpenRouter transcription failed."
          );
        })
        .finally(() => {
          window.clearTimeout(guardTimer);
          if (!mountedRef.current || transcriptionRunRef.current !== runId) {
            return;
          }
          mediaRecorderRef.current = null;
          setVoiceInputState("idle");
        });
    },
    [
      clearStopFallbackTimer,
      commitTranscriptToDraft,
      handleRecordedAudio,
      stopAudioStream,
    ]
  );

  const startVoiceInput = useCallback(async () => {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setVoiceInputError("Voice input is not supported in this browser.");
      return;
    }

    if (voiceBudgetExhausted) {
      setVoiceInputError("You've used today's voice budget.");
      return;
    }

    try {
      setVoiceInputError(null);
      recordedAudioChunksRef.current = [];
      recordingFinalizedRef.current = false;
      clearStopFallbackTimer();
      clearRecordingCapTimer();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      const mimeType = getPreferredRecordingMimeType();
      recordingMimeTypeRef.current = mimeType || "audio/webm";
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      );
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordedAudioChunksRef.current.push(event.data);
        }
      };

      recorder.onerror = () => {
        recordingFinalizedRef.current = true;
        clearStopFallbackTimer();
        clearRecordingCapTimer();
        stopAudioStream();
        mediaRecorderRef.current = null;
        recordedAudioChunksRef.current = [];
        if (!mountedRef.current) return;
        setVoiceInputState("idle");
        setVoiceInputError("Voice input recording failed. Try again.");
      };

      recorder.onstop = () => {
        finalizeRecordedAudio(recorder);
      };

      recorder.start(500);
      recordingStartedAtRef.current = Date.now();
      recordingDurationSecondsRef.current = 0;
      setVoiceInputState("recording");
      recordingCapTimerRef.current = setTimeout(() => {
        recordingCapTimerRef.current = null;
        if (mediaRecorderRef.current?.state === "recording") {
          try {
            mediaRecorderRef.current.stop();
          } catch {
            // Best-effort stop; the recorder may already be stopping from
            // another path (user click, unmount). Either way the onstop
            // handler runs finalize.
          }
        }
      }, voiceRecordingCapSeconds * 1000);
      posthog.capture(
        "chat_voice_input_recording_started",
        standardEventProps("chat_input")
      );
    } catch (error) {
      stopAudioStream();
      mediaRecorderRef.current = null;
      setVoiceInputState("idle");
      setVoiceInputError(
        error instanceof Error ? error.message : "Could not start voice input."
      );
    }
  }, [
    clearRecordingCapTimer,
    clearStopFallbackTimer,
    finalizeRecordedAudio,
    posthog,
    stopAudioStream,
    voiceBudgetExhausted,
    voiceRecordingCapSeconds,
  ]);

  const stopVoiceInput = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;

    setVoiceInputError(null);
    clearRecordingCapTimer();
    if (typeof recorder.requestData === "function") {
      try {
        recorder.requestData();
      } catch {
        // Some browser implementations throw if data is already queued.
      }
    }
    try {
      stopFallbackTimerRef.current = setTimeout(() => {
        finalizeRecordedAudio(recorder);
      }, 1500);
      recorder.stop();
      setVoiceInputState("transcribing");
    } catch (error) {
      clearStopFallbackTimer();
      stopAudioStream();
      mediaRecorderRef.current = null;
      setVoiceInputState("idle");
      setVoiceInputError(
        error instanceof Error ? error.message : "Could not stop voice input."
      );
      return;
    }
    posthog.capture(
      "chat_voice_input_recording_stopped",
      standardEventProps("chat_input")
    );
  }, [
    clearRecordingCapTimer,
    clearStopFallbackTimer,
    finalizeRecordedAudio,
    posthog,
    stopAudioStream,
  ]);

  const cancelVoiceInput = useCallback(() => {
    const recorder = mediaRecorderRef.current;

    transcriptionRunRef.current += 1;
    transcriptionAbortRef.current?.controller.abort();
    transcriptionAbortRef.current = null;
    recordingFinalizedRef.current = true;
    clearStopFallbackTimer();
    clearRecordingCapTimer();
    recordedAudioChunksRef.current = [];

    if (recorder?.state === "recording") {
      try {
        recorder.stop();
      } catch {
        // The recording is being discarded, so failing to stop is non-fatal.
      }
    }

    stopAudioStream();
    mediaRecorderRef.current = null;
    setVoiceInputError(null);
    setVoiceInputState("idle");
    posthog.capture(
      "chat_voice_input_recording_canceled",
      standardEventProps("chat_input")
    );
  }, [
    clearRecordingCapTimer,
    clearStopFallbackTimer,
    posthog,
    stopAudioStream,
  ]);

  useEffect(() => {
    if (voiceInputState !== "transcribing") return;

    const timeout = window.setTimeout(() => {
      transcriptionRunRef.current += 1;
      transcriptionAbortRef.current?.controller.abort();
      transcriptionAbortRef.current = null;
      recordingFinalizedRef.current = true;
      clearStopFallbackTimer();
      stopAudioStream();
      mediaRecorderRef.current = null;
      recordedAudioChunksRef.current = [];
      if (!mountedRef.current) return;
      setVoiceInputError(VOICE_TRANSCRIPTION_TIMEOUT_MESSAGE);
      setVoiceInputState("idle");
    }, VOICE_TRANSCRIPTION_GUARD_MS);

    return () => window.clearTimeout(timeout);
  }, [clearStopFallbackTimer, stopAudioStream, voiceInputState]);

  const handleVoiceInputClick = useCallback(() => {
    if (voiceInputState === "recording") {
      stopVoiceInput();
      return;
    }

    void startVoiceInput();
  }, [startVoiceInput, stopVoiceInput, voiceInputState]);

  const onSkillSelected = useCallback(
    (skillResult: SkillResult) => {
      // Add the skill result to the skillResults state
      onChangeSkillResults([...skillResults, skillResult]);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);
    },
    [value, caretIndex, onChange, skillResults, onChangeSkillResults]
  );

  const removeSkillResult = (index: number) => {
    onChangeSkillResults(skillResults.filter((_, i) => i !== index));
  };

  // Check if there are any results (prompts, skills, or files) selected
  const hasResults =
    mcpPromptResults.length > 0 ||
    skillResults.length > 0 ||
    fileAttachments.length > 0;
  const effectiveSelectedModels =
    selectedModels && selectedModels.length > 0
      ? selectedModels
      : [currentModel];
  const hideContextPopover = multiModelEnabled;

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const currentCaretIndex = event.currentTarget.selectionStart;
    if (
      isMCPPromptsRequested(value, currentCaretIndex) &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      setMcpPromptPopoverKeyTrigger(event.key);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      const trimmed = value.trim();
      event.preventDefault();
      if (
        (!trimmed && !hasResults) ||
        disabled ||
        submitDisabled ||
        isLoading
      ) {
        return;
      }
      formRef.current?.requestSubmit();
    }
  };

  const renderResultCards = () => {
    if (!hasResults) return null;
    return (
      <div className="px-4 pt-1 pb-0.5">
        <div className="flex flex-wrap gap-1.5">
          {mcpPromptResults.map((mcpPromptResult, index) => (
            <MCPPromptResultCard
              key={`prompt-${index}`}
              mcpPromptResult={mcpPromptResult}
              onRemove={() => removeMCPPromptResult(index)}
            />
          ))}
          {skillResults.map((skillResult, index) => (
            <SkillResultCard
              key={`skill-${index}`}
              skillResult={skillResult}
              skillsSource={skillsSource}
              onRemove={() => removeSkillResult(index)}
              onUpdate={(updatedSkill) => {
                const newSkillResults = [...skillResults];
                newSkillResults[index] = updatedSkill;
                onChangeSkillResults(newSkillResults);
              }}
            />
          ))}
        </div>
      </div>
    );
  };

  const renderFileAttachmentCards = () => {
    if (fileAttachments.length === 0) return null;
    return (
      <div className="px-4 pt-1 pb-0.5">
        <div className="flex flex-wrap gap-1.5">
          {fileAttachments.map((attachment) => (
            <FileAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onRemove={() => removeFileAttachment(attachment.id)}
            />
          ))}
        </div>
      </div>
    );
  };

  const chatboxHostFamily = getChatboxHostFamily(chatboxHostStyle);
  const composerClasses =
    chatboxHostFamily === "chatgpt"
      ? cn(
          "chatbox-host-composer rounded-[1.75rem]",
          isDarkChatboxTheme
            ? "border border-white/10 bg-[#303030] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
            : "border border-neutral-200/90 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]"
        )
      : chatboxHostFamily === "claude"
      ? cn(
          "chatbox-host-composer rounded-[1.35rem]",
          isDarkChatboxTheme
            ? "border-[#4b463d] bg-[#30302E] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
            : "border border-[#DFDFDB] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]"
        )
      : "rounded-3xl border border-border/40 bg-muted/70";
  const activeSubmitButtonClasses =
    chatboxHostFamily === "chatgpt"
      ? isDarkChatboxTheme
        ? "bg-[#f4f4f4] text-[#1f1f1f] hover:bg-[#e8e8e8]"
        : "bg-[#1f1f1f] text-white hover:bg-[#303030]"
      : chatboxHostFamily === "claude"
      ? isDarkChatboxTheme
        ? "bg-[#d07b53] text-[#fff7f0] hover:bg-[#c06f49]"
        : "bg-[#e27d47] text-white hover:bg-[#d16f3d]"
      : "bg-primary text-primary-foreground hover:bg-primary/90";
  const inactiveSubmitButtonClasses =
    chatboxHostFamily === "chatgpt"
      ? isDarkChatboxTheme
        ? "bg-[#3a3a3a] text-[#8a8a8a] cursor-not-allowed"
        : "bg-[#e7e7e7] text-[#9b9b9b] cursor-not-allowed"
      : chatboxHostFamily === "claude"
      ? isDarkChatboxTheme
        ? "bg-[#45413b] text-[#8d857a] cursor-not-allowed"
        : "bg-[#ebe5dc] text-[#b6ada0] cursor-not-allowed"
      : "bg-muted text-muted-foreground cursor-not-allowed";
  const voiceInputButtonLabel =
    voiceInputState === "recording"
      ? "Stop recording voice input"
      : "Start voice input";
  const voiceInputTooltip =
    voiceInputState === "recording"
      ? "Stop and transcribe"
      : voiceInputState === "transcribing"
      ? "Transcribing recording"
      : voiceBudgetExhausted
      ? "Out of voice budget for today"
      : "Voice input";
  const voiceInputDisabled =
    voiceInputState === "transcribing" ||
    (voiceInputState === "idle" &&
      (disabled || isLoading || voiceBudgetExhausted));
  const textareaDisplayValue =
    voiceInputState === "recording" ? "Listening..." : value;

  return (
    <>
      <form
        ref={formRef}
        className={cn("w-full", className)}
        onSubmit={onSubmit}
      >
        <div
          ref={containerRef}
          data-testid="chat-input-composer"
          className={cn(
            "relative flex w-full flex-col px-2 pt-2 pb-2",
            isFileDragActive &&
              "ring-2 ring-primary/45 ring-offset-2 ring-offset-background",
            composerClasses,
          )}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isFileDragActive && (
            <div
              className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-background/85 px-4 text-center text-sm font-medium text-foreground shadow-inner backdrop-blur-sm"
              role="status"
              aria-live="polite"
            >
              {DROP_OVERLAY_TEXT}
            </div>
          )}

          <PromptsPopover
            anchor={caret}
            selectedServers={selectedServers}
            onPromptSelected={onMCPPromptSelected}
            onSkillSelected={onSkillSelected}
            actionTrigger={mcpPromptPopoverKeyTrigger}
            setActionTrigger={setMcpPromptPopoverKeyTrigger}
            value={value}
            caretIndex={caretIndex}
            minimalMode={minimalMode}
            skillsSource={skillsSource}
          />

          {minimalMode &&
          chatboxAttachableServers &&
          chatboxAttachableServers.length > 0 &&
          onAttachChatboxServer ? (
            <div className="flex flex-wrap items-center gap-2 px-4 pb-1 pt-0.5">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 rounded-full border-dashed px-3 text-xs"
                    disabled={disabled}
                    aria-label="Add optional server"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add server
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-1" align="start">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    Connect an optional server. You may be asked to authorize.
                  </p>
                  <div className="max-h-48 overflow-y-auto">
                    {chatboxAttachableServers.map((s) => (
                      <button
                        key={s.serverId}
                        type="button"
                        className="flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm hover:bg-muted/80"
                        onClick={() => onAttachChatboxServer(s.serverId)}
                      >
                        <span className="truncate font-medium">
                          {s.serverName}
                        </span>
                        {s.useOAuth ? (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            OAuth
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          ) : null}

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={getFileInputAccept()}
            onChange={handleFileInputChange}
            className="hidden"
            aria-hidden="true"
          />

          {/* File Attachment Cards */}
          {renderFileAttachmentCards()}

          {/* MCP Prompts and Skills Cards */}
          {renderResultCards()}

          {/* File validation error */}
          {fileError && (
            <div className="px-4 py-1">
              <p className="text-xs text-destructive whitespace-pre-line">
                {fileError}
              </p>
            </div>
          )}

          {voiceInputError && (
            <div className="px-4 py-1" role="status" aria-live="polite">
              <p className="text-xs text-destructive">{voiceInputError}</p>
            </div>
          )}

          {!voiceInputError &&
            voiceInputState === "recording" &&
            voiceBudgetWarning && (
              <div className="px-4 py-1" role="status" aria-live="polite">
                <p className="text-xs text-muted-foreground">
                  {voiceBudgetWarning}
                </p>
              </div>
            )}

          <TextareaAutosize
            ref={textareaRef}
            value={textareaDisplayValue}
            onChange={(e) => {
              if (voiceInputState !== "idle") return;
              onChange(e.target.value);
              setCaretIndex(e.target.selectionStart);
            }}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            onKeyUp={(e) => setCaretIndex(e.currentTarget.selectionStart)}
            placeholder={placeholder}
            disabled={disabled && voiceInputState === "idle"}
            readOnly={disabled || voiceInputState !== "idle"}
            minRows={2}
            maxRows={4}
            className={cn(
              "min-h-[64px] w-full resize-none overflow-y-auto overscroll-contain border-none bg-transparent dark:bg-transparent px-4",
              "pt-2 pb-3 text-base text-foreground placeholder:text-muted-foreground/70",
              "outline-none focus-visible:outline-none focus-visible:ring-0 shadow-none focus-visible:shadow-none",
              voiceInputState === "recording" && "italic text-muted-foreground",
              disabled ? "cursor-not-allowed text-muted-foreground" : ""
            )}
            autoFocus={!disabled}
          />

          <div className="@container/toolbar flex items-center justify-between gap-2 px-2 min-w-0">
            <div className="flex items-center gap-1 min-w-0 flex-shrink overflow-hidden">
              {!minimalMode && (
                <Popover
                  open={plusPopoverOpen}
                  onOpenChange={handlePlusPopoverOpenChange}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-full"
                          disabled={disabled}
                          aria-label="Options"
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Options</TooltipContent>
                  </Tooltip>
                  <PopoverContent
                    className="w-72 p-0"
                    align="start"
                    side="top"
                    sideOffset={8}
                  >
                    {hasServerOptions && (
                      <div className="px-1 pt-1 pb-0">
                        <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
                          Servers
                        </p>
                        {allServerConfigs &&
                          onDisconnectServer &&
                          Object.keys(allServerConfigs).length > 0 && (
                            <div className="max-h-48 overflow-y-auto">
                              {Object.entries(allServerConfigs)
                                .sort(([aName, a], [bName, b]) => {
                                  const statusOrder: Record<string, number> = {
                                    connected: 0,
                                    connecting: 1,
                                    failed: 2,
                                  };
                                  const aOrder =
                                    statusOrder[a.connectionStatus] ?? 3;
                                  const bOrder =
                                    statusOrder[b.connectionStatus] ?? 3;
                                  if (aOrder !== bOrder) return aOrder - bOrder;
                                  return aName.localeCompare(bName);
                                })
                                .map(([name, server]) => {
                                  const isConnected =
                                    server.connectionStatus === "connected";
                                  const isConnecting =
                                    server.connectionStatus === "connecting";
                                  const isFailed =
                                    server.connectionStatus === "failed";
                                  const statusColor = isConnected
                                    ? "bg-green-500 dark:bg-green-400"
                                    : isConnecting
                                    ? "bg-yellow-500 dark:bg-yellow-400 animate-pulse"
                                    : isFailed
                                    ? "bg-red-500 dark:bg-red-400"
                                    : "bg-muted-foreground";

                                  return (
                                    <div
                                      key={name}
                                      className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-muted/60"
                                    >
                                      <div className="flex items-center gap-2 min-w-0">
                                        <div
                                          className={cn(
                                            "w-2 h-2 rounded-full shrink-0",
                                            statusColor
                                          )}
                                        />
                                        <span
                                          className={cn(
                                            "text-sm font-medium truncate",
                                            !isConnected &&
                                              !isConnecting &&
                                              "text-muted-foreground"
                                          )}
                                        >
                                          {name}
                                        </span>
                                        <span className="text-[10px] text-muted-foreground shrink-0">
                                          {server.config.command
                                            ? "STDIO"
                                            : "HTTP"}
                                        </span>
                                      </div>
                                      <div className="flex items-center shrink-0">
                                        {isConnecting ? (
                                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                        ) : isConnected ? (
                                          // Connectivity is the source of truth:
                                          // a connected server is "on", and
                                          // toggling off disconnects it.
                                          <Switch
                                            checked={true}
                                            onCheckedChange={() =>
                                              onDisconnectServer?.(name)
                                            }
                                          />
                                        ) : (
                                          <button
                                            type="button"
                                            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors cursor-pointer px-1.5 py-0.5 rounded hover:bg-primary/5"
                                            onClick={() => {
                                              onReconnectServer?.(name).catch(
                                                () => {}
                                              );
                                            }}
                                          >
                                            {isFailed ? "Retry" : "Connect"}
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          )}
                        {onAddServer && (
                          <button
                            type="button"
                            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 cursor-pointer"
                            onClick={() => {
                              setPlusPopoverOpen(false);
                              setAddServerModalOpen(true);
                            }}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            Add server
                          </button>
                        )}
                      </div>
                    )}

                    <div
                      className={cn(
                        "px-1 pb-1",
                        allServerConfigs &&
                          Object.keys(allServerConfigs).length > 0 &&
                          "border-t border-border mt-1 pt-1"
                      )}
                    >
                      {onChangeFileAttachments && (
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted/60 cursor-pointer"
                          onClick={() => {
                            posthog.capture(
                              "chat_attachment_button_clicked",
                              standardEventProps("chat_input")
                            );
                            setPlusPopoverOpen(false);
                            openFilePicker();
                          }}
                        >
                          <Paperclip className="h-4 w-4 text-muted-foreground" />
                          Attach files
                        </button>
                      )}

                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted/60 cursor-pointer"
                        onClick={() => {
                          setPlusPopoverOpen(false);
                          setSystemPromptOpen(true);
                        }}
                      >
                        <Settings2 className="h-4 w-4 text-muted-foreground" />
                        System Prompt & Temperature
                      </button>

                      {onRequireToolApprovalChange && (
                        <div className="flex items-center justify-between gap-2 rounded-md px-2 py-2 hover:bg-muted/60">
                          <div className="flex items-center gap-2 text-sm">
                            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                            Tool Approval
                          </div>
                          <Switch
                            checked={requireToolApproval}
                            onCheckedChange={(checked) =>
                              onRequireToolApprovalChange(checked)
                            }
                          />
                        </div>
                      )}

                      {showHostStyleSelectorControl && selectorHostStyle && (
                        <div className="mt-1 border-t border-border/70 px-2 py-[5px]">
                          <div className="flex items-center justify-between gap-2">
                            <p className="shrink-0 text-[9px] font-medium text-muted-foreground uppercase tracking-[0.18em]">
                              Client Style
                            </p>
                            <ClientStylePillSelector
                              className="w-[164px] shrink-0"
                              value={selectorHostStyle}
                              onValueChange={(nextStyle) =>
                                onHostStyleChange?.(nextStyle)
                              }
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {!minimalMode && clientSelector ? (
                <ClientSelector
                  {...clientSelector}
                  isLoading={isLoading}
                  onOpenChange={onModelSelectorOpenChange}
                  themeMode={resolvedThemeMode}
                  modalThemeMode={globalThemeMode}
                />
              ) : null}
              {!minimalMode && (
                <ModelSelector
                  currentModel={currentModel}
                  availableModels={availableModels}
                  onModelChange={onModelChange}
                  onOpenChange={onModelSelectorOpenChange}
                  isLoading={isLoading}
                  hasMessages={hasMessages}
                  enableMultiModel={enableMultiModel}
                  multiModelEnabled={multiModelEnabled}
                  selectedModels={effectiveSelectedModels}
                  onSelectedModelsChange={onSelectedModelsChange}
                  onMultiModelEnabledChange={onMultiModelEnabledChange}
                  respondToProviderTabIntent
                />
              )}
            </div>

            <div className="flex items-center gap-2 flex-shrink-0">
              {(voiceInputState === "recording" ||
                voiceInputState === "transcribing") && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-[34px] rounded-full text-muted-foreground shadow-none hover:bg-transparent hover:text-muted-foreground"
                      aria-label="Cancel voice input"
                      onClick={cancelVoiceInput}
                    >
                      <X size={18} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Cancel voice input</TooltipContent>
                </Tooltip>
              )}

              {voiceInputState === "recording" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      className={cn(
                        "size-[34px] rounded-full transition-colors shadow-none",
                        activeSubmitButtonClasses
                      )}
                      aria-label="Stop recording voice input"
                      onClick={stopVoiceInput}
                    >
                      <ArrowUp size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Use voice input</TooltipContent>
                </Tooltip>
              )}
              {voiceInputState === "idle" && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-[34px] rounded-full transition-colors shadow-none"
                      aria-label={voiceInputButtonLabel}
                      disabled={voiceInputDisabled}
                      onClick={handleVoiceInputClick}
                    >
                      <Mic size={16} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{voiceInputTooltip}</TooltipContent>
                </Tooltip>
              )}
              {voiceInputState === "idle" &&
                !minimalMode &&
                !hideContextPopover && (
                  <Context
                    usedTokens={tokenUsage?.totalTokens ?? 0}
                    usage={
                      tokenUsage && tokenUsage.totalTokens > 0
                        ? {
                            inputTokens: tokenUsage.inputTokens,
                            outputTokens: tokenUsage.outputTokens,
                            totalTokens: tokenUsage.totalTokens,
                            inputTokenDetails: {
                              noCacheTokens: undefined,
                              cacheReadTokens: undefined,
                              cacheWriteTokens: undefined,
                            },
                            outputTokenDetails: {
                              textTokens: undefined,
                              reasoningTokens: undefined,
                            },
                          }
                        : undefined
                    }
                    modelId={`${currentModel.id}`}
                    selectedServers={selectedServers}
                    mcpToolsTokenCount={mcpToolsTokenCount}
                    mcpToolsTokenCountLoading={mcpToolsTokenCountLoading}
                    connectedOrConnectingServerConfigs={
                      connectedOrConnectingServerConfigs
                    }
                    systemPromptTokenCount={systemPromptTokenCount}
                    systemPromptTokenCountLoading={
                      systemPromptTokenCountLoading
                    }
                    hasMessages={hasMessages}
                  >
                    <ContextTrigger />
                    {/* Only render popover content when there's something to show */}
                    {(hasMessages &&
                      tokenUsage &&
                      tokenUsage.totalTokens > 0) ||
                    (systemPromptTokenCount && systemPromptTokenCount > 0) ||
                    systemPromptTokenCountLoading ||
                    (mcpToolsTokenCount &&
                      Object.keys(mcpToolsTokenCount).length > 0) ||
                    mcpToolsTokenCountLoading ? (
                      <ContextContent>
                        {hasMessages &&
                          tokenUsage &&
                          tokenUsage.totalTokens > 0 && (
                            <ContextContentHeader />
                          )}
                        <ContextContentBody>
                          {hasMessages &&
                            tokenUsage &&
                            tokenUsage.totalTokens > 0 && (
                              <>
                                <ContextInputUsage />
                                <ContextOutputUsage />
                              </>
                            )}
                          <ContextSystemPromptUsage />
                          <ContextMCPServerUsage />
                        </ContextContentBody>
                      </ContextContent>
                    ) : null}
                  </Context>
                )}
              {voiceInputState === "transcribing" ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      className={cn(
                        "size-[34px] rounded-full transition-colors shadow-none",
                        inactiveSubmitButtonClasses
                      )}
                      aria-label="Transcribing recording"
                      disabled
                    >
                      <Loader2 size={16} className="animate-spin" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Transcribing recording…</TooltipContent>
                </Tooltip>
              ) : (
                voiceInputState !== "recording" &&
                (isLoading ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        className="size-[34px] rounded-full transition-colors"
                        aria-label="Stop generating"
                        onClick={() => stop()}
                      >
                        <Square size={16} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Stop generating</TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="submit"
                        size="icon"
                        aria-label="Send message"
                        className={cn(
                          "size-[34px] rounded-full transition-colors shadow-none",
                          (value.trim() || hasResults) &&
                            !disabled &&
                            !submitDisabled
                            ? activeSubmitButtonClasses
                            : inactiveSubmitButtonClasses,
                          pulseSubmit && "animate-onboarding-pulse"
                        )}
                        disabled={
                          (!value.trim() && !hasResults) ||
                          disabled ||
                          submitDisabled
                        }
                      >
                        <ArrowUp size={16} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Send message</TooltipContent>
                  </Tooltip>
                ))
              )}
            </div>
          </div>
        </div>
      </form>

      {onAddServer && (
        <AddServerModal
          isOpen={addServerModalOpen}
          onClose={() => setAddServerModalOpen(false)}
          onSubmit={(formData) => {
            onAddServer(formData);
            setAddServerModalOpen(false);
          }}
        />
      )}

      {!minimalMode && (
        <SystemPromptSelector
          systemPrompt={systemPrompt || DEFAULT_SYSTEM_PROMPT}
          onSystemPromptChange={onSystemPromptChange}
          temperature={temperature}
          onTemperatureChange={onTemperatureChange}
          isLoading={isLoading}
          hasMessages={hasMessages}
          onResetChat={onResetChat}
          currentModel={currentModel}
          multiModelEnabled={multiModelEnabled}
          selectedModels={effectiveSelectedModels}
          open={systemPromptOpen}
          onOpenChange={setSystemPromptOpen}
        />
      )}
    </>
  );
}
