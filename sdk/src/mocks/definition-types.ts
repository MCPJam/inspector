/**
 * The stored definition of a mock server, in MCP's own shapes. `tools` is a
 * map keyed by the name a client sees; an entry states only the fields it
 * changes and the rest follow the real server. The added words are `hidden`,
 * `params` and `answer`.
 *
 * Later stages add `prompts`, `resources` and `resourceTemplates` as more
 * optional maps on `MockDefinition`, and `answer.from` values `"saved"` and
 * `"model"` as more members of `MockAnswer`. The validator refuses them today.
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

/** Stage 3 adds `{ from: "saved" }` and `{ from: "model" }` here. */
export type MockAnswer = MockRealAnswer;

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
  tools?: Record<string, MockTool>;
}

/** Top-level keys a later stage builds; the validator refuses them today. */
export const MOCK_RESERVED_DEFINITION_KEYS = [
  "prompts",
  "resources",
  "resourceTemplates",
] as const;
