/**
 * The stored definition of a mock server, in MCP's own shapes. `tools` is a
 * map keyed by the name a client sees; an entry states only the fields it
 * changes and the rest follow the real server. The added words are `hidden`,
 * `params` and `answer`.
 *
 * Later stages add `prompts`, `resources` and `resourceTemplates` as more
 * optional maps on `MockDefinition`, and `answer.from` value `"model"` as
 * another member of `MockAnswer`. The validator refuses them today.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Hide, fix or describe one parameter of a tool. */
export interface MockToolParam {
  /** Remove it from the listed schema; nothing is sent for it. */
  hidden?: true;
  /** Remove it from the listed schema and send this value with every call. */
  fixed?: JsonValue;
  /** Replace the parameter's description in the listed schema. */
  description?: string;
}

/** `tool` names the real tool to call (a rename); `arguments` are laid over the client's. */
export interface MockRealAnswer {
  /** Omitted means `"real"`. */
  from?: "real";
  tool?: string;
  arguments?: JsonObject;
}

/** A protocol error a saved case answers with, as JSON-RPC carries it. */
export interface MockSavedError {
  code: number;
  message: string;
  data?: JsonValue;
}

/**
 * One saved case. `when` is a subset of the call's input: every key listed
 * must equal the call's value (deeply), extra input is ignored, and no `when`
 * matches any input. Exactly one of `result` (a whole `CallToolResult`) or
 * `error` (a protocol error) says what the mock answers. `{{input.x}}` in a
 * string of the result, or of the error's message or data, is filled from the
 * call's input.
 */
export interface MockSavedCase {
  when?: JsonObject;
  result?: JsonObject;
  error?: MockSavedError;
}

/** Cases are tried in order and the first that matches answers. There is no memory of earlier calls. */
export interface MockSavedAnswer {
  from: "saved";
  cases: MockSavedCase[];
}

export type MockAnswer = MockRealAnswer | MockSavedAnswer;

/** Whether the mock answers this tool's calls itself, without calling a real tool. */
export function answersItself(entry: MockTool | undefined): boolean {
  const from = entry?.answer?.from;
  return from === "saved";
}

/** The entry's answer when it calls a real tool; `undefined` when it answers itself. */
export function realAnswerOf(
  entry: MockTool | undefined
): MockRealAnswer | undefined {
  const answer = entry?.answer;
  return answer && answer.from !== "saved" ? answer : undefined;
}

/** The most saved cases one tool may carry. */
export const MAX_SAVED_CASES = 200;

export interface MockToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: JsonValue | undefined;
}

export interface MockTool {
  /** Remove the tool under this name. Only `answer.tool` may accompany it. */
  hidden?: true;
  title?: string;
  description?: string;
  /** Replaces the real input schema whole. Prefer `params` to change one parameter. */
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  /** Merged key by key over the real tool's annotations. */
  annotations?: MockToolAnnotations;
  icons?: JsonObject[];
  /** Merged key by key over the real tool's `_meta`. */
  _meta?: JsonObject;
  params?: Record<string, MockToolParam>;
  answer?: MockAnswer;
}

export interface MockServerInfo {
  name?: string;
  title?: string;
  version?: string;
}

export const MOCK_CAPABILITY_KEYS = [
  "tools",
  "prompts",
  "resources",
  "logging",
  "completions",
  "tasks",
  "experimental",
  "extensions",
] as const;

export type MockCapabilityKey = (typeof MOCK_CAPABILITY_KEYS)[number];

/** An object replaces the real server's entry; `null` removes it. `tools` cannot be removed. */
export type MockCapabilities = Partial<
  Record<MockCapabilityKey, JsonObject | null>
>;

export interface MockDefinition {
  serverInfo?: MockServerInfo;
  instructions?: string;
  capabilities?: MockCapabilities;
  /**
   * Lists the mock builds itself come in pages of this many entries. Left out,
   * each list is one page.
   */
  pageSize?: number;
  tools?: Record<string, MockTool>;
}

/** Top-level keys a later stage builds; the validator refuses them today. */
export const MOCK_RESERVED_DEFINITION_KEYS = [
  "prompts",
  "resources",
  "resourceTemplates",
] as const;
