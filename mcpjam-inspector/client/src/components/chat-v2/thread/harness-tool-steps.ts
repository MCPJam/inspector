/**
 * A one-line description of a harness tool call: a short verb and the thing
 * it acted on, for lists of steps where a JSON card per call would bury the
 * work. Native Claude Code names (`Read`, `Bash`, `mcp__server__tool`) and the
 * common names the server maps them to (`read`, `bash`) both resolve.
 */
export interface HarnessToolStepLabel {
  verb: string;
  /** What the step acted on (a file name, a command, a query). */
  detail?: string;
  /** The untrimmed value behind `detail`, for a tooltip. */
  title?: string;
  /** `detail` is code (a path, a command, a pattern), not prose. */
  code?: boolean;
}

type StepInput = Record<string, unknown> | undefined;

function stringField(input: StepInput, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return at >= 0 ? trimmed.slice(at + 1) || trimmed : trimmed;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? text;
  return line.length < text.length ? `${line} …` : line;
}

function file(
  verb: string,
  input: StepInput,
  ...keys: string[]
): HarnessToolStepLabel {
  const path = stringField(input, ...keys);
  return path
    ? { verb, detail: baseName(path), title: path, code: true }
    : { verb };
}

function text(
  verb: string,
  value: string | undefined,
  code = false,
): HarnessToolStepLabel {
  return value
    ? {
        verb,
        detail: firstLine(value),
        title: value,
        ...(code ? { code } : {}),
      }
    : { verb };
}

export function describeHarnessToolStep(
  toolName: string,
  input?: Record<string, unknown>,
): HarnessToolStepLabel {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return { verb: mcp[2]!, detail: mcp[1]!, title: toolName };
  switch (toolName.toLowerCase()) {
    case "read":
      return file("Read", input, "file_path", "path");
    case "write":
      return file("Write", input, "file_path", "path");
    case "edit":
    case "multiedit":
      return file("Edit", input, "file_path", "path");
    case "notebookedit":
      return file("Edit", input, "notebook_path");
    case "bash": {
      // Codex parses what a command does; one read, listing or search reads
      // better as that than as the shell line.
      const action = codexCommandAction(input);
      if (action?.type === "read") {
        const path = stringField(action, "path", "name");
        return path
          ? {
              verb: "Read",
              detail: stringField(action, "name") ?? baseName(path),
              title: path,
              code: true,
            }
          : { verb: "Read" };
      }
      if (action?.type === "listFiles") {
        return text("List files", stringField(action, "path"), true);
      }
      if (action?.type === "search") {
        return text("Search", stringField(action, "query", "command"), true);
      }
      const description = stringField(input, "description");
      return description
        ? text("Run", description)
        : text("Run", stringField(input, "command"), true);
    }
    case "grep":
      return text("Search", stringField(input, "pattern"), true);
    case "glob":
      return text("Find files", stringField(input, "pattern"), true);
    case "webfetch":
      return text("Fetch", stringField(input, "url"), true);
    case "websearch":
      return text("Search the web", stringField(input, "query"));
    case "agent":
    case "task":
      return text("Agent", stringField(input, "description"));
    case "filechange": {
      const paths = editedPaths(input);
      if (paths.length === 1) return file("Edit", { path: paths[0] }, "path");
      return paths.length > 1
        ? {
            verb: "Edit",
            detail: `${paths.length} files`,
            title: paths.join("\n"),
          }
        : { verb: "Edit" };
    }
    case "todowrite":
      return { verb: "Update todos" };
    case "skill":
      return text("Skill", stringField(input, "skill", "name"));
    default: {
      const first = input
        ? Object.values(input).find(
            (value): value is string =>
              typeof value === "string" && value.trim().length > 0,
          )
        : undefined;
      return text(toolName, first?.trim());
    }
  }
}

/** The one thing a Codex command does, when Codex could tell. */
function codexCommandAction(
  input: StepInput,
): (Record<string, unknown> & { type: string }) | undefined {
  const actions = input?.commandActions;
  if (!Array.isArray(actions) || actions.length !== 1) return undefined;
  const action = actions[0] as Record<string, unknown> | null;
  return action && typeof action.type === "string" && action.type !== "unknown"
    ? (action as Record<string, unknown> & { type: string })
    : undefined;
}

/**
 * Harness built-ins whose calls are the agent's own legwork (commands, reads,
 * edits, searches) rather than the thing under test. Their cards say what each
 * call did. MCP tools, the Agent card, questions and plan-mode exits are not
 * here.
 */
const HARNESS_BUILT_IN_TOOL_NAMES = new Set([
  "bash",
  "bashoutput",
  "killshell",
  "killbash",
  "read",
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "filechange",
  "grep",
  "glob",
  "websearch",
  "webfetch",
  "todowrite",
]);

export function isHarnessActivityToolName(toolName: string): boolean {
  return HARNESS_BUILT_IN_TOOL_NAMES.has(toolName.toLowerCase());
}

function editedPaths(input: StepInput): string[] {
  const changes = input?.changes;
  if (Array.isArray(changes)) {
    return changes
      .map((change) => (change as { path?: unknown })?.path)
      .filter((path): path is string => typeof path === "string");
  }
  const path = stringField(input, "file_path", "notebook_path", "path");
  return path ? [path] : [];
}

/**
 * What a built-in call literally acts on: the command line, the file path,
 * the pattern. For approvals, where the user must see what will run, not the
 * model's own description of it.
 */
export function harnessToolTarget(
  toolName: string,
  input?: Record<string, unknown>,
): string | undefined {
  switch (toolName.toLowerCase()) {
    case "bash":
      return stringField(input, "command", "cmd");
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return stringField(input, "file_path", "path");
    case "notebookedit":
      return stringField(input, "notebook_path");
    case "filechange": {
      const paths = editedPaths(input);
      return paths.length > 0 ? paths.join(", ") : undefined;
    }
    case "grep":
    case "glob":
      return stringField(input, "pattern");
    case "webfetch":
      return stringField(input, "url");
    case "websearch":
      return stringField(input, "query");
    default:
      return undefined;
  }
}
