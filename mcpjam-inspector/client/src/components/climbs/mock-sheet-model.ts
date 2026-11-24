/**
 * Editing a mock's tools in the mock sheet: a definition and what a person
 * typed in, an edited definition out. The sheet keeps one draft per tool the
 * person touched; every other tool stays byte for byte as it was stored.
 */
import {
  MAX_SAVED_CASES,
  answersItself,
  realAnswerOf,
  validateMockDefinition,
  type JsonObject,
  type JsonValue,
  type MockDefinition,
  type MockSavedCase,
  type MockTool,
} from "@mcpjam/sdk/mocks/definition";
import type { PlatformMockServer } from "@mcpjam/sdk/platform";

export type Answering = "server" | "saved" | "model";

/** A case already stored, or one the person is writing (text until save checks it). */
export type CaseRow =
  | { id: string; kind: "stored"; saved: MockSavedCase }
  | { id: string; kind: "new"; whenKey: string; whenValue: string; resultText: string };

export type ToolDraft = {
  description: string;
  answering: Answering;
  rows: CaseRow[];
  instructions: string;
  /** Counts new rows so each keeps one id after others are removed. */
  added: number;
};

/** What the real server lists for a tool, as far as the sheet shows it. */
export type RealTool = { description?: string; inputSchema?: unknown };

export { MAX_SAVED_CASES };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The real server's tools by name. `whatCanChange` lists every tool the real
 * server has; `realServer.tools` only the ones the definition edits, so it
 * fills in what the first lacks.
 */
export function realTools(mock: Pick<PlatformMockServer, "whatCanChange" | "realServer">): Record<string, RealTool> {
  const tools: Record<string, RealTool> = {};
  for (const entry of mock.whatCanChange ?? []) {
    const { kind, tool, field } = entry.where;
    if (kind !== "tool" || !tool) continue;
    tools[tool] ??= {};
    if (field === "description" && typeof entry.current === "string") tools[tool].description = entry.current;
    if (field === "inputSchema") tools[tool].inputSchema = entry.current;
  }
  for (const listed of mock.realServer.tools) {
    if (!listed.found || tools[listed.realTool]) continue;
    tools[listed.realTool] = { description: asText(listed.current.description), inputSchema: listed.current.inputSchema };
  }
  return tools;
}

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Every tool the mock lists: the real server's, then the ones the definition adds. Hidden ones are not listed. */
export function toolNames(definition: MockDefinition, real: Record<string, RealTool>): string[] {
  const entries = definition.tools ?? {};
  const names = [...Object.keys(real), ...Object.keys(entries).filter((name) => !(name in real))];
  return names.filter((name) => entries[name]?.hidden !== true);
}

/** The tool as the person first sees it. */
export function initialDraft(definition: MockDefinition, name: string, real: RealTool | undefined): ToolDraft {
  const entry = definition.tools?.[name];
  const answer = entry?.answer;
  return {
    description: entry?.description ?? real?.description ?? "",
    answering: answer?.from === "saved" ? "saved" : answer?.from === "model" ? "model" : "server",
    rows: answer?.from === "saved" ? answer.cases.map((saved, index) => ({ id: `stored-${index}`, kind: "stored", saved })) : [],
    instructions: answer?.from === "model" ? (answer.instructions ?? "") : "",
    added: 0,
  };
}

/**
 * Whether the tool can answer from your server: the real server lists it, or
 * the entry renames one of its tools. A tool only the mock lists has no real
 * tool to call, and a mock that sends it there refuses to list its tools.
 */
export function canAnswerFromServer(definition: MockDefinition, name: string, real: RealTool | undefined): boolean {
  return real !== undefined || realAnswerOf(definition.tools?.[name]) !== undefined;
}

/** The input schema to show and whether the definition replaced it. */
export function schemaOf(
  definition: MockDefinition,
  name: string,
  real: RealTool | undefined,
): { schema: unknown; edited: boolean } {
  const own = definition.tools?.[name]?.inputSchema;
  return own ? { schema: own, edited: true } : { schema: real?.inputSchema, edited: false };
}

export function addCase(draft: ToolDraft): ToolDraft {
  if (draft.rows.length >= MAX_SAVED_CASES) return draft;
  const row: CaseRow = { id: `new-${draft.added}`, kind: "new", whenKey: "", whenValue: "", resultText: "" };
  return { ...draft, rows: [...draft.rows, row], added: draft.added + 1 };
}

export const removeCase = (draft: ToolDraft, id: string): ToolDraft => ({
  ...draft,
  rows: draft.rows.filter((row) => row.id !== id),
});

/** A typed `when` value is JSON when it parses (41, true, "41") and a plain string otherwise (run_41). */
export function parseWhenValue(text: string): JsonValue {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as JsonValue;
  } catch {
    return trimmed;
  }
}

/** The text that parses back to `value`: a string shows bare unless it would read as another type. */
export function whenValueText(value: JsonValue): string {
  if (typeof value === "string") return parseWhenValue(value) === value ? value : JSON.stringify(value);
  return JSON.stringify(value);
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** One written case, checked: a `when` of one key, and a result that is a JSON object. */
export function parseCaseRow(row: Extract<CaseRow, { kind: "new" }>): Parsed<MockSavedCase> {
  const key = row.whenKey.trim();
  if (key !== "" && row.whenValue.trim() === "") {
    return { ok: false, error: `Give a value for "${key}", or clear the key to answer every call.` };
  }
  let result: unknown;
  try {
    result = JSON.parse(row.resultText);
  } catch {
    return { ok: false, error: "The saved result is not valid JSON. Fix it, then save." };
  }
  if (!isObject(result)) {
    return { ok: false, error: 'The saved result is a JSON object, such as {"content": [{"type": "text", "text": "Done."}]}.' };
  }
  const when = key === "" ? {} : { when: { [key]: parseWhenValue(row.whenValue) } };
  return { ok: true, value: { ...when, result: result as JsonObject } };
}

/** A stored case in words: which input it matches and what it answers. */
export function describeCase(saved: MockSavedCase): { when: string; answer: string } {
  const pairs = Object.entries(saved.when ?? {}).map(([key, value]) => `${key} is ${whenValueText(value)}`);
  return {
    when: pairs.length === 0 ? "any call" : pairs.join(" and "),
    answer: JSON.stringify(saved.error ? { error: saved.error } : saved.result ?? {}, null, 2),
  };
}

function casesOf(name: string, draft: ToolDraft): Parsed<MockSavedCase[]> {
  const cases: MockSavedCase[] = [];
  for (const [index, row] of draft.rows.entries()) {
    if (row.kind === "stored") {
      cases.push(row.saved);
      continue;
    }
    const parsed = parseCaseRow(row);
    if (!parsed.ok) return { ok: false, error: `${name}, case ${index + 1}: ${parsed.error}` };
    cases.push(parsed.value);
  }
  return { ok: true, value: cases };
}

function editedTool(name: string, entry: MockTool | undefined, draft: ToolDraft, real: RealTool | undefined): Parsed<MockTool> {
  const next: MockTool = { ...entry };
  // A description equal to the real one follows the real one, so a tool stays unedited when nothing differs.
  if (draft.description !== (entry?.description ?? real?.description ?? "")) {
    if (draft.description.trim() === "" || draft.description === real?.description) delete next.description;
    else next.description = draft.description;
  }
  if (draft.answering === "server") {
    if (!real && !realAnswerOf(entry)) {
      return { ok: false, error: `Your server has no tool named "${name}", so the mock has to answer it. Choose Saved answers or A model.` };
    }
    if (answersItself(entry)) delete next.answer;
    else if (realAnswerOf(entry)) next.answer = entry?.answer;
  } else if (draft.answering === "model") {
    const instructions = draft.instructions.trim();
    next.answer = { from: "model", ...(instructions ? { instructions: draft.instructions } : {}) };
  } else {
    const cases = casesOf(name, draft);
    if (!cases.ok) return cases;
    next.answer = { from: "saved", cases: cases.value };
  }
  return { ok: true, value: next };
}

/** The definition with the touched tools replaced; the first unreadable case stops it with a message. */
export function applyDrafts(
  definition: MockDefinition,
  drafts: Record<string, ToolDraft>,
  real: Record<string, RealTool>,
): Parsed<MockDefinition> {
  const tools: Record<string, MockTool> = { ...definition.tools };
  for (const [name, draft] of Object.entries(drafts)) {
    const edited = editedTool(name, tools[name], draft, real[name]);
    if (!edited.ok) return edited;
    if (Object.keys(edited.value).length === 0) delete tools[name];
    else tools[name] = edited.value;
  }
  const next: MockDefinition = { ...definition, tools };
  if (Object.keys(tools).length === 0) delete next.tools;
  return { ok: true, value: next };
}

/** The SDK's own check, as a sentence: the first issue names its path and what to do. */
export function checkDefinition(definition: MockDefinition): Parsed<MockDefinition> {
  const checked = validateMockDefinition(definition);
  if (checked.ok) return { ok: true, value: checked.definition };
  const [first, ...more] = checked.issues;
  return { ok: false, error: more.length > 0 ? `${first.message} (${more.length} more to fix.)` : first.message };
}

/** Whether a save was refused because the mock gained a version after the sheet read it. */
export function isStaleSave(error: unknown): boolean {
  return isObject(error) && error.code === "MOCK_VERSION_STALE";
}
