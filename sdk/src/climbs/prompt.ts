/**
 * The prompt `stop_climb` returns: the kept changes, in order, for the coding
 * agent that works on the server's code. Changes that also helped on
 * validation cases come first, because they are the ones the least likely to
 * have fit the steering cases alone. The prompt names no validation or
 * confirmation case.
 */
import { describePlace } from "../mocks/change-kinds.js";
import type { MockChange, MockFieldChange } from "../mocks/change-list.js";
import type { CodeRound, KeptRound } from "./types.js";

const MAX_VALUE_CHARS = 4_000;

function show(value: unknown): string {
  if (value === undefined) return "(not set)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}... (cut at ${MAX_VALUE_CHARS} characters)` : text;
}

function describeField(change: MockChange, detail: MockFieldChange): string {
  return [
    `- ${detail.summary} (${detail.path} of ${describePlace(change)})`,
    `  Was: ${show(detail.before)}`,
    `  Now: ${show(detail.after)}`,
  ].join("\n");
}

/** A code round has no edits to list: the code the saved server runs is the change. */
function describeCode(code: CodeRound): string {
  const name = code.serverName ?? `saved server ${code.serverId}`;
  return `- Ran ${name}, which runs your own code. That code is the change: keep it by merging the branch the server runs.`;
}

function describeChange(change: MockChange): string {
  if (change.details.length === 0) return `- ${change.summary}`;
  return change.details.map((detail) => describeField(change, detail)).join("\n");
}

const standing = (round: KeptRound) =>
  [
    round.validation === "better" ? "also better on validation cases" : round.validation === "unchanged" ? "validation cases did not move" : undefined,
    round.overruled ? "kept by an overrule" : undefined,
  ]
    .filter(Boolean)
    .join(", ");

export function climbPrompt(input: { serverName: string; kept: readonly KeptRound[] }): string {
  const { serverName, kept } = input;
  if (kept.length === 0) {
    return `No round of this climb stands as kept, so there is nothing to apply to ${serverName}.`;
  }
  const ordered = [...kept].sort((a, b) => {
    const better = (round: KeptRound) => (round.validation === "better" ? 0 : 1);
    return better(a) - better(b) || a.number - b.number;
  });
  const sections = ordered.map((round, index) => {
    const header = `${index + 1}. Round ${round.number}${standing(round) ? ` (${standing(round)})` : ""}`;
    return [header, ...(round.code ? [describeCode(round.code)] : round.changes.map(describeChange))].join("\n");
  });
  const hasCode = kept.some((round) => round.code);
  const hasMock = kept.some((round) => !round.code);
  return [
    `Bring these changes into the code of ${serverName}. Each was kept by the climb's rule. A round that ran a mock lists edits to make: make each so the server lists or serves exactly what "Now" says, keeping everything else as it is. A round that ran a saved server with its own code is code to keep: merge the branch that server runs.`,
    "Changes that also helped on validation cases come first.",
    "",
    sections.join("\n\n"),
    "",
    [
      "When the changes are in and the server runs the new code, commit them and call verify_climb with the commit.",
      hasMock ? "For mock edits, it checks the server's listing against them, then runs the server beside a mock that puts the old values back." : undefined,
      hasCode ? "For a code change, it runs the server alone and sets its numbers beside the ones the climb recorded." : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  ].join("\n");
}
