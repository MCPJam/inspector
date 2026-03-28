/**
 * Generates a markdown "Agent Brief" from an exported MCP server payload.
 * Pure utility — no React or DOM dependencies.
 */

import {
  EXPLORE_TO_SDK_EVALS_SKILL_MD,
  SKILL_MD,
} from "@mcpjam/sdk/skill-reference";

export interface ExportedTool {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<
      string,
      { type?: string; description?: string; [k: string]: unknown }
    >;
    required?: string[];
    [k: string]: unknown;
  };
  outputSchema?: object;
}

export interface ExportedResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface ExportedPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; required?: boolean }[];
}

export interface ExportPayload {
  serverId: string;
  exportedAt: string;
  tools: ExportedTool[];
  resources: ExportedResource[];
  prompts: ExportedPrompt[];
}

/** Serializable explore case slice for agent briefs (not tied to Convex / React). */
export interface AgentBriefExploreCase {
  title: string;
  query: string;
  isNegativeTest?: boolean;
  scenario?: string;
  expectedOutput?: string;
  expectedToolCalls?: Array<{
    toolName: string;
    arguments: Record<string, unknown>;
  }>;
}

/** Minimal case shape (e.g. Convex EvalCase) for `mapEvalCasesToAgentBriefExploreCases`. */
export interface EvalCaseForAgentBrief {
  title: string;
  query: string;
  isNegativeTest?: boolean;
  scenario?: string;
  expectedOutput?: string;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
}

export function mapEvalCasesToAgentBriefExploreCases(
  cases: EvalCaseForAgentBrief[],
): AgentBriefExploreCase[] {
  return cases.map((c) => {
    const slice: AgentBriefExploreCase = {
      title: c.title,
      query: c.query,
    };
    if (c.isNegativeTest !== undefined) {
      slice.isNegativeTest = c.isNegativeTest;
    }
    if (c.scenario !== undefined && c.scenario !== "") {
      slice.scenario = c.scenario;
    }
    if (c.expectedOutput !== undefined && c.expectedOutput.trim() !== "") {
      slice.expectedOutput = c.expectedOutput;
    }
    if (c.expectedToolCalls.length > 0) {
      slice.expectedToolCalls = c.expectedToolCalls.map((t) => ({
        toolName: t.toolName,
        arguments: { ...t.arguments } as Record<string, unknown>,
      }));
    }
    return slice;
  });
}

export interface GenerateAgentBriefOptions {
  /** Max tools to show in the full table (rest are listed as names). Default: 30 */
  maxToolsInTable?: number;
  /** Max characters for tool description in the table. Default: 120 */
  maxDescriptionLength?: number;
  /** Server URL (for HTTP) or command string (for stdio) to embed in the brief */
  serverUrl?: string;
  /** Optional MCPJam Explore-generated cases to include before the embedded skill */
  exploreTestCases?: AgentBriefExploreCase[];
}

export function generateAgentBrief(
  data: ExportPayload,
  options?: GenerateAgentBriefOptions,
): string {
  const maxTools = options?.maxToolsInTable ?? 30;
  const maxDesc = options?.maxDescriptionLength ?? 120;
  const serverUrl = options?.serverUrl;
  const exploreTestCases = options?.exploreTestCases;

  const lines: string[] = [];

  // ── Header ──
  lines.push(`# MCP Server Brief: ${data.serverId}`);
  lines.push("");
  lines.push(`> Exported ${data.exportedAt}`);
  if (serverUrl) {
    const isStdio = serverUrl.includes(" ") && !serverUrl.startsWith("http");
    if (isStdio) {
      lines.push(`>\n> **Connection (stdio):** \`${serverUrl}\``);
    } else {
      lines.push(`>\n> **Connection:** \`${serverUrl}\``);
    }
  }
  lines.push("");

  // ── Capability Summary ──
  lines.push("## Capability Summary");
  lines.push("");
  const parts: string[] = [];
  if (data.tools.length > 0) parts.push(`${data.tools.length} tools`);
  if (data.resources.length > 0)
    parts.push(`${data.resources.length} resources`);
  if (data.prompts.length > 0) parts.push(`${data.prompts.length} prompts`);
  lines.push(parts.length > 0 ? parts.join(", ") : "No capabilities detected");
  lines.push("");

  // ── Tools Table ──
  if (data.tools.length > 0) {
    lines.push("## Tools");
    lines.push("");
    lines.push("| Tool | Description | Key Parameters |");
    lines.push("|------|-------------|----------------|");

    const toolsForTable = data.tools.slice(0, maxTools);
    for (const tool of toolsForTable) {
      const desc = truncate(tool.description ?? "", maxDesc);
      const params = formatToolParams(tool);
      lines.push(
        `| \`${tool.name}\` | ${escapeCell(desc)} | ${escapeCell(params)} |`,
      );
    }

    if (data.tools.length > maxTools) {
      const remaining = data.tools.slice(maxTools);
      lines.push("");
      lines.push(
        `+${remaining.length} more: ${remaining.map((t) => `\`${t.name}\``).join(", ")}`,
      );
    }

    lines.push("");
  }

  // ── Resources ──
  if (data.resources.length > 0) {
    lines.push("## Resources");
    lines.push("");
    lines.push("| URI | Name | Type |");
    lines.push("|-----|------|------|");
    for (const res of data.resources) {
      lines.push(
        `| \`${res.uri}\` | ${escapeCell(res.name ?? "")} | ${escapeCell(res.mimeType ?? "")} |`,
      );
    }
    lines.push("");
  }

  // ── Prompts ──
  if (data.prompts.length > 0) {
    lines.push("## Prompts");
    lines.push("");
    lines.push("| Name | Description | Arguments |");
    lines.push("|------|-------------|-----------|");
    for (const prompt of data.prompts) {
      const args = (prompt.arguments ?? [])
        .map((a) => `${a.name}${a.required ? " (required)" : ""}`)
        .join(", ");
      lines.push(
        `| \`${prompt.name}\` | ${escapeCell(prompt.description ?? "")} | ${escapeCell(args)} |`,
      );
    }
    lines.push("");
  }

  // ── Suggested Eval Scenarios ──
  lines.push("## Suggested Eval Scenarios");
  lines.push("");

  // Single-tool selection (up to 3)
  lines.push("### Single-Tool Selection");
  lines.push("");
  const singleToolCandidates = data.tools.slice(0, 3);
  if (singleToolCandidates.length > 0) {
    for (const tool of singleToolCandidates) {
      const desc = tool.description
        ? ` — "${truncate(tool.description, 80)}"`
        : "";
      lines.push(`- \`${tool.name}\`${desc}`);
    }
  } else {
    lines.push("- No tools available");
  }
  lines.push("");

  // Multi-tool workflow (detect related tools by shared prefix)
  lines.push("### Multi-Tool Workflow");
  lines.push("");
  const workflows = detectMultiToolWorkflows(data.tools);
  if (workflows.length > 0) {
    for (const wf of workflows) {
      lines.push(`- \`${wf.from}\` → \`${wf.to}\`: ${wf.description}`);
    }
  } else {
    lines.push(
      "- No obvious multi-tool workflows detected. Consider chaining tools that share a resource type.",
    );
  }
  lines.push("");

  // Argument accuracy (tools with required params)
  lines.push("### Argument Accuracy");
  lines.push("");
  const toolsWithRequired = data.tools.filter(
    (t) => t.inputSchema?.required && t.inputSchema.required.length > 0,
  );
  if (toolsWithRequired.length > 0) {
    for (const tool of toolsWithRequired.slice(0, 5)) {
      const params = (tool.inputSchema!.required ?? [])
        .map((name) => {
          const prop = tool.inputSchema?.properties?.[name];
          const type = prop?.type ?? "unknown";
          return `${name} (${type})`;
        })
        .join(", ");
      lines.push(`- \`${tool.name}\` requires: ${params}`);
    }
  } else {
    lines.push("- No tools with required parameters detected.");
  }
  lines.push("");

  // Negative test
  lines.push("### Negative Test");
  lines.push("");
  lines.push(
    '- Irrelevant prompt should trigger no tool calls (e.g., "What is the capital of France?")',
  );
  lines.push("");

  if (exploreTestCases && exploreTestCases.length > 0) {
    lines.push("## Explore-generated test cases");
    lines.push("");
    lines.push(
      "These prompts and expectations were produced in MCPJam Explore and can be turned into SDK eval tests using the skill reference below.",
    );
    lines.push("");
    for (const c of exploreTestCases) {
      lines.push(`### ${escapeHeadingText(c.title)}`);
      lines.push("");
      lines.push("**User prompt:**");
      lines.push("");
      lines.push("```");
      lines.push(c.query);
      lines.push("```");
      lines.push("");
      if (c.isNegativeTest) {
        lines.push("- **Negative test:** expect no tool calls.");
        if (c.scenario) {
          lines.push(`- **Scenario:** ${escapeCell(c.scenario)}`);
        }
        lines.push("");
      }
      if (c.expectedOutput?.trim()) {
        lines.push(
          `**Expected output / experience:** ${escapeCell(c.expectedOutput.trim())}`,
        );
        lines.push("");
      }
      if (c.expectedToolCalls && c.expectedToolCalls.length > 0) {
        lines.push("**Expected tool calls (shape):**");
        lines.push("");
        for (const call of c.expectedToolCalls) {
          lines.push(
            `- \`${formatCompactToolCall(call.toolName, call.arguments)}\``,
          );
        }
        lines.push("");
      }
    }
  }

  // ── Eval SDK Reference (embedded SKILL.md) ──
  lines.push("---");
  lines.push("");
  lines.push(
    exploreTestCases && exploreTestCases.length > 0
      ? EXPLORE_TO_SDK_EVALS_SKILL_MD
      : SKILL_MD,
  );
  lines.push("");

  return lines.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHeadingText(title: string): string {
  return title.replace(/\s+/g, " ").trim() || "Untitled";
}

function formatCompactArgValue(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    const q = JSON.stringify(
      value.length > 48 ? `${value.slice(0, 45)}...` : value,
    );
    return q;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  let s = JSON.stringify(value);
  if (s.length > 72) {
    s = `${s.slice(0, 69)}...`;
  }
  return s;
}

function formatCompactToolCall(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `${k}: ${formatCompactArgValue(v)}`)
    .join(", ");
  return `${toolName}({${inner}})`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

function escapeCell(str: string): string {
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function formatToolParams(tool: ExportedTool): string {
  const props = tool.inputSchema?.properties;
  if (!props) return "—";

  const required = new Set(tool.inputSchema?.required ?? []);
  const entries = Object.entries(props).slice(0, 5);

  if (entries.length === 0) return "—";

  const formatted = entries.map(([name, schema]) => {
    const type = schema.type ?? "any";
    const req = required.has(name) ? ", required" : "";
    return `\`${name}\` (${type}${req})`;
  });

  const remaining = Object.keys(props).length - entries.length;
  if (remaining > 0) {
    formatted.push(`+${remaining} more`);
  }

  return formatted.join(", ");
}

interface WorkflowPair {
  from: string;
  to: string;
  description: string;
}

function detectMultiToolWorkflows(tools: ExportedTool[]): WorkflowPair[] {
  const workflows: WorkflowPair[] = [];
  const toolNames = new Set(tools.map((t) => t.name));

  // Detect list_X / get_X pairs
  for (const tool of tools) {
    if (tool.name.startsWith("list_")) {
      const resource = tool.name.slice(5); // "list_projects" → "projects"
      // Look for get_<singular> or get_<plural>
      const singular = resource.replace(/s$/, "");
      const getMatch = toolNames.has(`get_${singular}`)
        ? `get_${singular}`
        : toolNames.has(`get_${resource}`)
          ? `get_${resource}`
          : null;
      if (getMatch) {
        workflows.push({
          from: tool.name,
          to: getMatch,
          description: `List then fetch detail for ${resource}`,
        });
      }
    }

    // Detect search_X / get_X pairs
    if (tool.name.startsWith("search_")) {
      const resource = tool.name.slice(7);
      const singular = resource.replace(/s$/, "");
      const getMatch = toolNames.has(`get_${singular}`)
        ? `get_${singular}`
        : toolNames.has(`get_${resource}`)
          ? `get_${resource}`
          : null;
      if (getMatch) {
        workflows.push({
          from: tool.name,
          to: getMatch,
          description: `Search then fetch detail for ${resource}`,
        });
      }
    }

    // Detect create_X / get_X pairs
    if (tool.name.startsWith("create_")) {
      const resource = tool.name.slice(7);
      const singular = resource.replace(/s$/, "");
      const getMatch = toolNames.has(`get_${singular}`)
        ? `get_${singular}`
        : toolNames.has(`get_${resource}`)
          ? `get_${resource}`
          : null;
      if (getMatch) {
        workflows.push({
          from: tool.name,
          to: getMatch,
          description: `Create then verify ${resource}`,
        });
      }
    }
  }

  // Deduplicate and limit
  const seen = new Set<string>();
  return workflows
    .filter((wf) => {
      const key = `${wf.from}→${wf.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
}
