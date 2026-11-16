import type { LocalHarnessId } from "@/shared/harness-descriptors";

/**
 * What each local runtime tells a member before it runs on their computer:
 * what it can reach, what Tool Approval gates, and who pays. Typed against
 * every local runtime, so a runtime that becomes local does not compile until
 * its own copy is written here.
 */
export const LOCAL_RUNTIME_COPY: {
  readonly [Id in LocalHarnessId]: {
    /** The trust dialog's paragraphs. */
    trust: readonly string[];
    /** Create client's note after "Install <name> on this computer." */
    setup: string;
    /** Added to the trust dialog's Permissions detail, if anything is. */
    permissions?: string;
  };
} = {
  "claude-code": {
    trust: [
      "Claude Code can read and change any files your account can access, including files outside this folder.",
      "With Tool Approval on, chat commands and file changes need your approval.",
      "Usage is billed through MCPJam credits or your organization’s API key. Personal Claude subscriptions don’t apply.",
    ],
    setup:
      "It runs commands in its project folder with your account’s permissions. Evals and swarms use this client’s approval settings.",
  },
  codex: {
    trust: [
      "Codex runs with your account’s permissions. With Tool Approval on, commands, file changes and reads need your approval.",
      "Personal Codex and ChatGPT subscriptions don’t cover usage here.",
      "See Details for eval and swarm restrictions.",
    ],
    setup:
      "It runs commands in its project folder with your account’s permissions. Codex evals and swarms run locally on Apple silicon Macs and in the cloud elsewhere.",
    permissions:
      "Evals and swarms run locally only on verified platforms. Commands can write only the run folder and a private temp folder, and have no network. Reads are unrestricted. MCP tools run outside that sandbox under your tool policy. Elsewhere, evals and swarms run in the cloud.",
  },
  "copilot-cli": {
    trust: [
      "GitHub Copilot CLI doesn’t run commands or change files itself. It only calls the tools this chat gives it.",
      "With Tool Approval on, each tool call needs your approval.",
      "Usage is billed through MCPJam credits or your organization’s OpenAI key. Personal GitHub Copilot subscriptions don’t apply.",
    ],
    setup:
      "It doesn’t run commands or change files itself, and it calls only the tools a chat gives it. Evals and swarms use this client’s approval settings.",
  },
  cursor: {
    trust: [
      "Cursor CLI can read and change any files your account can access, including files outside this folder.",
      "With Tool Approval on, commands and file changes need your approval.",
      "Usage runs on your organization’s Cursor account. Personal Cursor subscriptions don’t apply.",
    ],
    setup:
      "It runs commands in its project folder with your account’s permissions. Evals and swarms use this client’s approval settings.",
  },
};
