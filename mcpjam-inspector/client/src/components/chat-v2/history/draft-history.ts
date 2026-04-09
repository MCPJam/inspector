import type { FileAttachment } from "@/components/chat-v2/chat-input/attachments/file-utils";
import type { MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";

export function buildDraftHistoryPreview(options: {
  input: string;
  mcpPromptResults: MCPPromptResult[];
  skillResults: SkillResult[];
  fileAttachments: FileAttachment[];
}): string {
  return options.input.trim();
}

export function resolveRestoredDraftInput(resumeConfig?: {
  draftInput?: string;
}): string {
  return resumeConfig?.draftInput ?? "";
}
