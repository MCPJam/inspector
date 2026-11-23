import type { HostTerminalPresentation } from "./types";

export const CLAUDE_CODE_TERMINAL: HostTerminalPresentation = {
  variant: "claude-code",
  prompt: "❯",
  reply: "⏺",
  tool: "└",
};

export const CODEX_TERMINAL: HostTerminalPresentation = {
  variant: "codex",
  prompt: "›",
  reply: "•",
  tool: "•",
};
