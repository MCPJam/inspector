/**
 * The instructions a turn's MCP servers sent, as one system-prompt section.
 *
 * A server describes how to use its tools in `instructions`: the initialize
 * result through protocol 2025-11-25, the `server/discover` result from
 * 2026-07-28. MCP suggests the client put them in the system prompt, and
 * Claude Code does, in one section with a subsection per server. This module
 * renders them the same way.
 *
 * `prepareChatV2` builds the section once per turn, after its tool listing has
 * connected the servers, and puts it in the prompt of MCPJam's harness. A
 * vendor harness gets the same text only where MCPJam's MCP client serves its
 * tools: where its own MCP client does, the handshake MCPJam forwards already
 * carries the instructions, and adding them again would deliver them twice.
 */
import type { ConnectionsByServerId } from "@mcpjam/sdk";

/** Claude Code's heading and lead line, so both hosts read alike. */
const HEADING = "# MCP Server Instructions";
const LEAD =
  "The following MCP servers have provided instructions for how to use their tools and resources:";

/** What the section reads from the turn's `MCPClientManager`. */
export interface InstructionsSource {
  hasServer(key: string): boolean;
  getInitializationInfo(
    key: string,
  ): { instructions?: string | undefined } | undefined;
}

export interface ServerInstructionsInput {
  manager: InstructionsSource;
  /** The turn's selected server ids. */
  serverIds: readonly string[];
  /** Each server's connections, when the turn routes between accounts. */
  groups?: ConnectionsByServerId;
  /**
   * serverId → the name the host shows for the server. Assigned by the host,
   * never taken from `serverInfo.name`, so a server cannot pass itself off as
   * another. A server with no label is headed by its id.
   */
  labels?: Readonly<Record<string, string>>;
  /**
   * Servers the turn runs without. A server's handshake can succeed while its
   * tool listing fails, so it still has instructions, for tools the model
   * does not have.
   */
  unavailable?: Iterable<string>;
}

interface Subsection {
  label: string;
  text: string;
}

/**
 * The section, or `""` when no selected server sent instructions.
 *
 * Each server appears once under its label. A server whose connections sent
 * different texts appears once per connection instead, labelled with the
 * connection, so neither text is lost. Two servers that sent the same text
 * both appear: each is a separate source. The text is verbatim.
 */
export function buildServerInstructions(
  input: ServerInstructionsInput,
): string {
  const skipped = new Set(input.unavailable ?? []);
  const subsections: Subsection[] = [];
  for (const serverId of new Set(input.serverIds)) {
    if (skipped.has(serverId)) continue;
    const label = input.labels?.[serverId]?.trim() || serverId;
    const connections = input.groups?.[serverId] ?? [
      { key: serverId, label },
    ];
    const sent = connections.flatMap((connection) => {
      const text = input.manager.hasServer(connection.key)
        ? input.manager.getInitializationInfo(connection.key)?.instructions?.trim()
        : undefined;
      return text ? [{ label: connection.label, text }] : [];
    });
    const [first, ...rest] = sent;
    if (!first) continue;
    if (rest.every((other) => other.text === first.text)) {
      subsections.push({ label, text: first.text });
      continue;
    }
    for (const connection of sent) {
      subsections.push({
        label: `${label} (${connection.label})`,
        text: connection.text,
      });
    }
  }
  if (subsections.length === 0) return "";
  subsections.sort((a, b) => a.label.localeCompare(b.label));
  return [
    HEADING,
    LEAD,
    ...subsections.map(({ label, text }) => `## ${label}\n${text}`),
  ].join("\n\n");
}
