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
