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

type ActivityKind =
  "command" | "read" | "edit" | "search" | "webSearch" | "fetch" | "todo";

/**
 * Harness built-ins whose calls are the agent's own legwork (commands, reads,
 * edits, searches) rather than the thing under test. Runs of these fold into
 * one activity row. MCP tools, the Agent card, questions and plan-mode exits
 * are not here: each keeps its own card.
 */
const ACTIVITY_KINDS: Record<string, ActivityKind> = {
  bash: "command",
  bashoutput: "command",
  killshell: "command",
  killbash: "command",
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  filechange: "edit",
  grep: "search",
  glob: "search",
  websearch: "webSearch",
  webfetch: "fetch",
  todowrite: "todo",
};

export function isHarnessActivityToolName(toolName: string): boolean {
  return toolName.toLowerCase() in ACTIVITY_KINDS;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many.replace("#", String(n));
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
 * "Ran 2 commands, read 3 files": what a run of activity calls did, in the
 * order each kind first appears.
 */
export function summarizeHarnessActivity(
  calls: Array<{ toolName: string; input?: Record<string, unknown> }>,
): string {
  const counts = new Map<ActivityKind | "other", number>();
  const edited = new Set<string>();
  let editsWithoutPath = 0;
  for (const call of calls) {
    let kind = ACTIVITY_KINDS[call.toolName.toLowerCase()] ?? "other";
    if (kind === "command") {
      const action = codexCommandAction(call.input);
      if (action?.type === "read") kind = "read";
      else if (action?.type === "listFiles" || action?.type === "search") {
        kind = "search";
      }
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (kind === "edit") {
      const paths = editedPaths(call.input);
      if (paths.length === 0) editsWithoutPath++;
      for (const path of paths) edited.add(path);
    }
  }
  const phrases: string[] = [];
  for (const [kind, n] of counts) {
    switch (kind) {
      case "command":
        phrases.push(plural(n, "ran a command", "ran # commands"));
        break;
      case "read":
        phrases.push(plural(n, "read a file", "read # files"));
        break;
      case "edit":
        phrases.push(
          plural(
            edited.size + editsWithoutPath,
            "edited a file",
            "edited # files",
          ),
        );
        break;
      case "search":
        phrases.push(plural(n, "searched once", "searched # times"));
        break;
      case "webSearch":
        phrases.push(plural(n, "searched the web", "searched the web # times"));
        break;
      case "fetch":
        phrases.push(plural(n, "fetched a page", "fetched # pages"));
        break;
      case "todo":
        phrases.push("updated the todos");
        break;
      default:
        phrases.push(plural(n, "used a tool", "used # tools"));
    }
  }
  const text = phrases.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
