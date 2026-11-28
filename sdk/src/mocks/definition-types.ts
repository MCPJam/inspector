/**
 * The stored definition of a mock server, in MCP's own shapes. `tools` is a
 * map keyed by the name a client sees; an entry states only the fields it
 * changes and the rest follow the real server. The added words are `hidden`,
 * `params` and `answer`.
 *
 * Prompts, resources (skills and MCP Apps among them) and templates are
 * validated and served, and so are a saved case's `steps` (what it sends and
 * asks while it runs) and `task`. Answers from a model are out of scope:
 * `answer.from` is `"real"` or `"saved"`.
 */

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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
  /** What the mock sends and asks before it answers, in order. */
  steps?: MockStep[];
  /** Run as a task when the caller can take one; otherwise the call answers in place. */
  task?: true;
  result?: JsonObject;
  error?: MockSavedError;
}

export type MockLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

interface StepTiming {
  /** Wait this long before the step, so a caller or a poll can see the one before it. */
  delayMs?: number;
}

/** The lists a `listChanged` step announces. */
export type MockListKind = "tools" | "prompts" | "resources";

/**
 * One thing a saved case does before it answers. `ask`, `askUrl` and `sample`
 * need an `id`: the reply is read in the result as `{{steps.<id>.action}}`,
 * `{{steps.<id>.content.<field>}}` (a form's values) or `{{steps.<id>.text}}`
 * (a model's text). `{{input.x}}` is filled in a step's text too.
 */
export type MockStep = StepTiming &
  (
    | { kind: "progress"; progress: number; total?: number; message?: string }
    | { kind: "log"; level: MockLogLevel; data: JsonValue; logger?: string }
    /** Tells the client a list changed (`notifications/<list>/list_changed`). */
    | { kind: "listChanged"; list: MockListKind }
    /** Tells subscribers a resource of the mock changed (`notifications/resources/updated`). */
    | { kind: "resourceUpdated"; uri: string }
    /** A question to the person, as a form. */
    | { kind: "ask"; id: string; message: string; requestedSchema: JsonObject }
    /** A question that sends the person to a page. */
    | { kind: "askUrl"; id: string; message: string; url: string }
    /** A request to the client's model. */
    | {
        kind: "sample";
        id: string;
        prompt: string;
        systemPrompt?: string;
        maxTokens: number;
      }
  );

export const MAX_CASE_STEPS = 20;
export const MAX_STEP_DELAY_MS = 5000;
export const MAX_CASE_DELAY_MS = 20000;
export const MAX_SAMPLE_TOKENS = 4096;
/** The most suggestions one completion argument may list. */
export const MAX_COMPLETION_VALUES = 1000;

/** Whether the step waits for the client (a question or a model request). */
export function isInputStep(
  step: MockStep
): step is Extract<MockStep, { kind: "ask" | "askUrl" | "sample" }> {
  return (
    step.kind === "ask" || step.kind === "askUrl" || step.kind === "sample"
  );
}

function savedCasesOf(definition: MockDefinition): MockSavedCase[] {
  return Object.values(definition.tools ?? {}).flatMap((tool) =>
    tool.answer?.from === "saved" ? tool.answer.cases : []
  );
}

/** Whether any saved case of any tool has a step that satisfies `test`. */
export function definitionHasStep(
  definition: MockDefinition,
  test: (step: MockStep) => boolean
): boolean {
  return savedCasesOf(definition).some((c) => c.steps?.some(test));
}

/** Whether any saved case of the definition runs as a task. */
export function definitionRunsTasks(definition: MockDefinition): boolean {
  return savedCasesOf(definition).some((c) => c.task === true);
}

/** Whether a tool has a saved case that runs as a task. */
export function toolRunsTasks(entry: MockTool | undefined): boolean {
  return (
    entry?.answer?.from === "saved" && entry.answer.cases.some((c) => c.task)
  );
}

/** Cases are tried in order and the first that matches answers. There is no memory of earlier calls. */
export interface MockSavedAnswer {
  from: "saved";
  cases: MockSavedCase[];
}

export type MockAnswer = MockRealAnswer | MockSavedAnswer;

/** Whether the mock answers this tool's calls itself, without calling a real tool. */
export function answersItself(entry: MockTool | undefined): boolean {
  return entry?.answer?.from === "saved" || entry?.state !== undefined;
}

/** The real tool an entry points at: `answer.tool`, else its own key. */
export function realToolNameFor(key: string, entry: MockTool): string {
  return realAnswerOf(entry)?.tool ?? key;
}

/** The entry's answer when it calls a real tool; `undefined` when it answers itself. */
export function realAnswerOf(
  entry: MockTool | undefined
): MockRealAnswer | undefined {
  const answer = entry?.answer;
  return answer && (answer.from === undefined || answer.from === "real")
    ? answer
    : undefined;
}

/** The most saved cases one tool may carry. */
export const MAX_SAVED_CASES = 200;

/** The five operations a tool can declare on the mock's records. */
export const MOCK_STATE_OPS = [
  "get",
  "list",
  "create",
  "patch",
  "delete",
] as const;

export type MockStateOp = (typeof MOCK_STATE_OPS)[number];

/** The most records one `list` returns, and the count it returns when `limit` is left out. */
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 50;

/**
 * A tool the mock answers from its records. Values in `key`, `where`, `value`,
 * `set`, `limit` and `cursor` are literals or `{{input.<path>}}` references;
 * `result` is a template over `record` (`records` for `list`) and `input`.
 * Without `result` the tool returns the record itself.
 */
export interface MockToolState {
  op: MockStateOp;
  collection: string;
  key?: string;
  /** `list`: records whose fields all equal these values. */
  where?: JsonObject;
  /** `list`: 1 to 200, default 50. A number, or a reference to one. */
  limit?: number | string;
  /** `list`: where to continue, from an earlier `nextCursor`. */
  cursor?: string;
  /** `create`: the new record. */
  value?: JsonObject;
  /** `patch`: the fields to change. */
  set?: JsonObject;
  result?: JsonObject;
}

/** Collection name, then record key, to the records a definition starts from. */
export type MockSeed = Record<string, Record<string, JsonObject>>;

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
  /** The tool reads or changes the mock's records. Cannot accompany a saved answer. */
  state?: MockToolState;
}

export interface MockPromptArgument {
  name: string;
  title?: string;
  description?: string;
  required?: boolean;
}

/** `content` is one content block, as MCP carries it: `{ type: "text", text }` and the like. */
export type MockPromptMessage = {
  role: "user" | "assistant";
  content: JsonObject;
};

/**
 * An entry states only what it changes on the real server's prompt of the same
 * name. With `messages` the prompt is the mock's own: it is listed from the
 * entry (added when the real server lacks it) and `prompts/get` answers from
 * the messages, with `{{input.x}}` filled from the call's arguments.
 */
export interface MockPrompt {
  /** Remove the prompt under this name. Nothing else may accompany it. */
  hidden?: true;
  title?: string;
  description?: string;
  /** Replaces the real prompt's argument list whole. */
  arguments?: MockPromptArgument[];
  icons?: JsonObject[];
  /** Merged key by key over the real prompt's `_meta`. */
  _meta?: JsonObject;
  messages?: MockPromptMessage[];
}

/**
 * A resource of the real server, edited, hidden, or added. With `text` or
 * `blob` (base64) the mock serves the content itself. An added resource needs
 * one of them; its name defaults to the last segment of its URI.
 */
export interface MockResource {
  hidden?: true;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: JsonObject;
  icons?: JsonObject[];
  _meta?: JsonObject;
  text?: string;
  blob?: string;
}

/**
 * A resource template. With `text` or `blob`, a `resources/read` of a URI the
 * template matches is answered from it, with `{{input.<variable>}}` filled
 * from the URI. Hiding a template only removes it from the listing.
 */
export interface MockResourceTemplate {
  hidden?: true;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonObject;
  icons?: JsonObject[];
  _meta?: JsonObject;
  text?: string;
  blob?: string;
}

/** The mimeType of an MCP App's HTML. */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

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
  /** The records each state context starts from. */
  seed?: MockSeed;
  /** Keyed by the prompt name a client sees. */
  prompts?: Record<string, MockPrompt>;
  /** Keyed by resource URI. A `skill://` entry is a skill file and a `ui://` entry an MCP App. */
  resources?: Record<string, MockResource>;
  /** Keyed by the RFC 6570 URI template a client sees. */
  resourceTemplates?: Record<string, MockResourceTemplate>;
  /** The suggestions `completion/complete` gives for prompt and template arguments. */
  completions?: MockCompletions;
}

/**
 * Suggestions by argument. `prompts` is keyed by prompt name and
 * `resourceTemplates` by URI template; each maps an argument (or template
 * variable) name to the values the mock suggests. An argument with no list here
 * is completed by the real server, when it has completions.
 */
export interface MockCompletions {
  prompts?: Record<string, Record<string, string[]>>;
  resourceTemplates?: Record<string, Record<string, string[]>>;
}
