// Static, zero-traffic hygiene lints over a tools/list catalog.
//
// Each rule targets an agent-facing failure mode repeatedly observed in
// production MCP telemetry (wrong-key guessing, required IDs agents can't
// know, undocumented constraints, context-window floods). The doctor surfaces
// findings as advisory warnings: they never affect readiness or exit codes.

export type ToolLintRule =
  | "missing-description"
  | "unknowable-required-id"
  | "inconsistent-param-naming"
  | "undocumented-constraint"
  | "unbounded-list-tool";

export interface ToolLintFinding {
  rule: ToolLintRule;
  /** Tool name(s) the finding applies to. */
  tools: string[];
  /** Offending input-schema property, when the finding is param-scoped. */
  param?: string;
  /** Human-readable explanation with the suggested fix. */
  message: string;
}

interface LintableTool {
  name: string;
  description: string;
  properties: Record<string, Record<string, unknown>>;
  required: Set<string>;
}

const MIN_DESCRIPTION_LENGTH = 10;
const MAX_TOOLS_PER_SPELLING = 3;

// "project_id", "insight-id", bare "id"/"uuid" — but not "grid" or "valid".
const SNAKE_ID_PATTERN = /(^|[_-])(id|ids|uuid|guid)$/i;
// "projectId", "sessionIds", "traceUUID" — uppercase boundary keeps "grid" out.
const CAMEL_ID_PATTERN = /[a-z0-9](Id|Ids|ID|IDs|Uuid|UUID|Guid|GUID)$/;

// Words suggesting the description tells the agent where a value comes from.
const DISCOVERY_HINT_PATTERN =
  /\b(list|lists|search|find|found|look\s*-?\s*up|lookup|via|from|returned|returns|response|result|discover|obtain|see|call|use|active|current|default|created)\b/i;

// Numeric schema constraints agents only see if the prose repeats them.
const CONSTRAINT_KEYS = ["maxLength", "minLength", "maximum", "minimum"] as const;

const LIST_NAME_TOKENS = new Set([
  "list",
  "search",
  "query",
  "history",
  "logs",
  "traces",
  "events",
  "export",
  "all",
  "recent",
]);

const PAGINATION_PARAM_NAMES = new Set([
  "limit",
  "max",
  "maxresults",
  "maxitems",
  "maxcount",
  "pagesize",
  "perpage",
  "first",
  "top",
  "count",
  "size",
  "cursor",
  "offset",
  "page",
  "pagetoken",
  "before",
  "after",
]);

const RULE_ORDER: Record<ToolLintRule, number> = {
  "missing-description": 0,
  "unknowable-required-id": 1,
  "inconsistent-param-naming": 2,
  "undocumented-constraint": 3,
  "unbounded-list-tool": 4,
};

export function lintToolCatalog(tools: unknown[]): ToolLintFinding[] {
  const lintable = narrowTools(tools);
  const findings: ToolLintFinding[] = [
    ...lintMissingDescriptions(lintable),
    ...lintUnknowableRequiredIds(lintable),
    ...lintInconsistentParamNaming(lintable),
    ...lintUndocumentedConstraints(lintable),
    ...lintUnboundedListTools(lintable),
  ];

  return findings.sort(
    (a, b) =>
      RULE_ORDER[a.rule] - RULE_ORDER[b.rule] ||
      (a.tools[0] ?? "").localeCompare(b.tools[0] ?? "") ||
      (a.param ?? "").localeCompare(b.param ?? "")
  );
}

function narrowTools(tools: unknown[]): LintableTool[] {
  const lintable: LintableTool[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") {
      continue;
    }

    const { name, description, inputSchema } = tool as {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
    };
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }

    const schema =
      inputSchema && typeof inputSchema === "object"
        ? (inputSchema as { properties?: unknown; required?: unknown })
        : {};
    const properties: Record<string, Record<string, unknown>> = {};
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, value] of Object.entries(
        schema.properties as Record<string, unknown>
      )) {
        properties[key] =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)
            : {};
      }
    }

    lintable.push({
      name,
      description: typeof description === "string" ? description : "",
      properties,
      required: new Set(
        Array.isArray(schema.required)
          ? schema.required.filter(
              (entry): entry is string => typeof entry === "string"
            )
          : []
      ),
    });
  }

  return lintable;
}

function lintMissingDescriptions(tools: LintableTool[]): ToolLintFinding[] {
  return tools
    .filter((tool) => tool.description.trim().length < MIN_DESCRIPTION_LENGTH)
    .map((tool) => ({
      rule: "missing-description" as const,
      tools: [tool.name],
      message:
        "Tool has no meaningful description. Agents pick tools and fill parameters from prose, so an empty description invites wrong calls.",
    }));
}

function lintUnknowableRequiredIds(tools: LintableTool[]): ToolLintFinding[] {
  const findings: ToolLintFinding[] = [];

  for (const tool of tools) {
    for (const param of tool.required) {
      if (!isIdLikeParamName(param)) {
        continue;
      }
      const prose = `${readDescription(tool.properties[param])} ${tool.description}`;
      if (DISCOVERY_HINT_PATTERN.test(prose)) {
        continue;
      }
      findings.push({
        rule: "unknowable-required-id",
        tools: [tool.name],
        param,
        message: `"${param}" is required and looks like an opaque identifier, but nothing says where to get one. Agents guess values or fail validation — name the tool that returns it, or make it optional with a default.`,
      });
    }
  }

  return findings;
}

function lintInconsistentParamNaming(tools: LintableTool[]): ToolLintFinding[] {
  // normalized param name -> exact spelling -> tools using that spelling
  const groups = new Map<string, Map<string, string[]>>();

  for (const tool of tools) {
    for (const param of Object.keys(tool.properties)) {
      const normalized = param.toLowerCase().replace(/[_-]/g, "");
      if (normalized.length === 0) {
        continue;
      }
      const spellings = groups.get(normalized) ?? new Map<string, string[]>();
      const toolNames = spellings.get(param) ?? [];
      toolNames.push(tool.name);
      spellings.set(param, toolNames);
      groups.set(normalized, spellings);
    }
  }

  const findings: ToolLintFinding[] = [];
  for (const spellings of groups.values()) {
    if (spellings.size < 2) {
      continue;
    }
    const parts = [...spellings.entries()].map(
      ([spelling, toolNames]) => `"${spelling}" (${describeTools(toolNames)})`
    );
    findings.push({
      rule: "inconsistent-param-naming",
      tools: [...new Set([...spellings.values()].flat())],
      message: `The same parameter is spelled ${spellings.size} ways across tools: ${parts.join(
        ", "
      )}. Agents mix spellings up and ping-pong between rejections — standardize on one, or accept the others as aliases.`,
    });
  }

  return findings;
}

function lintUndocumentedConstraints(tools: LintableTool[]): ToolLintFinding[] {
  const findings: ToolLintFinding[] = [];

  for (const tool of tools) {
    for (const [param, schema] of Object.entries(tool.properties)) {
      const description = readDescription(schema);
      const undocumented = CONSTRAINT_KEYS.filter((key) => {
        const value = schema[key];
        if (typeof value !== "number") {
          return false;
        }
        // Trivial bounds agents never trip over.
        if (key === "minLength" && value <= 1) {
          return false;
        }
        if (key === "minimum" && value === 0) {
          return false;
        }
        return !description.includes(String(value));
      });
      if (undocumented.length === 0) {
        continue;
      }
      const constraints = undocumented
        .map((key) => `${key} ${schema[key]}`)
        .join(", ");
      findings.push({
        rule: "undocumented-constraint",
        tools: [tool.name],
        param,
        message: `"${param}" enforces ${constraints} in the schema, but the prose never mentions it. Agents that only read descriptions overrun the limit and get an opaque rejection — state it in the description.`,
      });
    }
  }

  return findings;
}

function lintUnboundedListTools(tools: LintableTool[]): ToolLintFinding[] {
  const findings: ToolLintFinding[] = [];

  for (const tool of tools) {
    if (!tokenizeName(tool.name).some((token) => LIST_NAME_TOKENS.has(token))) {
      continue;
    }
    const hasBound = Object.keys(tool.properties).some((param) =>
      PAGINATION_PARAM_NAMES.has(param.toLowerCase().replace(/[_-]/g, ""))
    );
    if (hasBound) {
      continue;
    }
    findings.push({
      rule: "unbounded-list-tool",
      tools: [tool.name],
      message:
        "Looks like a list/query tool, but no limit or pagination parameter bounds the response. One broad call can flood the model's context window — add a limit/cursor and cap the serialized response size.",
    });
  }

  return findings;
}

function isIdLikeParamName(name: string): boolean {
  return SNAKE_ID_PATTERN.test(name) || CAMEL_ID_PATTERN.test(name);
}

function readDescription(
  schema: Record<string, unknown> | undefined
): string {
  const description = schema?.description;
  return typeof description === "string" ? description : "";
}

function describeTools(toolNames: string[]): string {
  const shown = toolNames.slice(0, MAX_TOOLS_PER_SPELLING).join(", ");
  const hidden = toolNames.length - MAX_TOOLS_PER_SPELLING;
  return hidden > 0 ? `${shown} +${hidden} more` : shown;
}

function tokenizeName(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}
