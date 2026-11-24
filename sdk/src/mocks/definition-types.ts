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
  /** What the mock sends and asks before it answers, in order. */
  steps?: MockStep[];
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

/** Whether the step waits for the client (a question or a model request). */
export function isInputStep(
  step: MockStep
): step is Extract<MockStep, { kind: "ask" | "askUrl" | "sample" }> {
  return (
    step.kind === "ask" || step.kind === "askUrl" || step.kind === "sample"
  );
}

/** Whether any saved case of the definition asks the client something. */
export function definitionAsks(definition: MockDefinition): boolean {
  return savedCasesOf(definition).some((c) => c.steps?.some(isInputStep));
}

/** Whether any saved case sends a log message. */
export function definitionLogs(definition: MockDefinition): boolean {
  return savedCasesOf(definition).some((c) =>
    c.steps?.some((step) => step.kind === "log")
  );
}

function savedCasesOf(definition: MockDefinition): MockSavedCase[] {
  return Object.values(definition.tools ?? {}).flatMap((tool) =>
    tool.answer?.from === "saved" ? tool.answer.cases : []
  );
}

/** Cases are tried in order and the first that matches answers. There is no memory of earlier calls. */
export interface MockSavedAnswer {
  from: "saved";
  cases: MockSavedCase[];
}

/**
 * A model answers as the server would, from the tool's description and these
 * instructions. The answer is stored on first use, keyed by the mock version,
 * the tool and the input, and replayed after, so the same call gets the same
 * answer.
 */
export interface MockModelAnswer {
  from: "model";
  /** How this tool should answer: what the data looks like, what it refuses. */
  instructions?: string;
}

export type MockAnswer = MockRealAnswer | MockSavedAnswer | MockModelAnswer;

/** Whether the mock answers this tool's calls itself, without calling a real tool. */
export function answersItself(entry: MockTool | undefined): boolean {
  const from = entry?.answer?.from;
  return from === "saved" || from === "model";
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
  /** Keyed by the prompt name a client sees. */
  prompts?: Record<string, MockPrompt>;
  /** Keyed by resource URI. A `skill://` entry is a skill file and a `ui://` entry an MCP App. */
  resources?: Record<string, MockResource>;
  /** Keyed by the RFC 6570 URI template a client sees. */
  resourceTemplates?: Record<string, MockResourceTemplate>;
}
