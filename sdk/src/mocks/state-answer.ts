import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { checkToolArgs } from "../conformance-tool-args.js";
import type { MockToolState } from "./definition-types.js";
import type { MockObserver } from "./mock-observer.js";
import { checkStructuredOutput } from "./output-schema.js";
import {
  fingerprintToolCall,
  MAX_OPERATION_KEY_LENGTH,
  MockRecordRefusedError,
  OPERATION_KEY_META,
} from "./record-store.js";
import type {
  MockRecordErrorCode,
  MockRecords,
  MockRecordWrite,
} from "./record-store.js";
import { toolErrorResult } from "./self-answer.js";
import { bindOperation, shapeResult } from "./state-ops.js";

export interface StateCall {
  /** The tool as the mock lists it. */
  tool: Tool | undefined;
  name: string;
  state: MockToolState;
  input: Record<string, unknown>;
  /** The request's `_meta`, where a caller's operation key rides. */
  meta: Record<string, unknown> | undefined;
  /** Absent when the host gave the mock no records. */
  records: MockRecords | undefined;
  observer?: MockObserver;
}

function recordRefusal(
  name: string,
  state: MockToolState,
  code: MockRecordErrorCode
): string {
  const where = `"${state.collection}"`;
  switch (code) {
    case "not_found":
      return `${name} found no record in ${where} under that key. Check the key, or create the record first.`;
    case "already_exists":
      return `${name} did not create the record: ${where} already has one under that key. Use a different key, or patch the existing record.`;
    case "stale_epoch":
      return `${name} was refused because this test run was reset after the connection opened. Reconnect to the run's current URL, then call again.`;
    case "operation_conflict":
      return `${name} was refused because its operation key was already used for a different request. Send a new operation key, or repeat the original request unchanged.`;
    case "invalid_cursor":
      return `${name} was given a cursor the mock did not issue. Pass the nextCursor from the previous page, or leave the cursor out.`;
    case "records_full":
      return `${name} did not create the record: ${where} is in a scope that already holds 10,000 records, the most it can. Delete some records, then call again.`;
  }
}

/** The caller's operation key, or an error to return when it is not usable. */
function operationKeyOf(
  meta: Record<string, unknown> | undefined
): { key?: string } | { error: string } {
  const key = meta?.[OPERATION_KEY_META];
  if (key === undefined) return {};
  if (
    typeof key !== "string" ||
    key === "" ||
    key.length > MAX_OPERATION_KEY_LENGTH
  ) {
    return {
      error: `The operation key in _meta["${OPERATION_KEY_META}"] must be a string of 1 to ${MAX_OPERATION_KEY_LENGTH} characters. Send a shorter key, or leave it out.`,
    };
  }
  return { key };
}

/**
 * A call to a tool that declares `state`: the input is checked against the
 * listed schema before any reference is bound, the operation runs on the
 * host's store, and the record (or the `result` template over it) is the
 * structured result. A missing or existing key, a stale epoch and a conflicting
 * operation key are tool errors; nothing is forwarded.
 */
export async function answerFromState(
  call: StateCall
): Promise<CallToolResult> {
  const { name, state, input, observer } = call;
  const report = (
    refusal?: "invalid_input" | "invalid_output" | "record_refused"
  ) => observer?.({ tool: name, source: "state", ...(refusal && { refusal }) });
  const verdict = checkToolArgs(call.tool?.inputSchema, input);
  if (verdict.verdict === "invalid") {
    report("invalid_input");
    return toolErrorResult(
      `Input validation error: invalid arguments for tool ${name}: ${verdict.message}. Fix the arguments and call it again.`
    );
  }
  if (!call.records) {
    report("record_refused");
    return toolErrorResult(
      `${name} reads the mock's records, and this connection has none. Open the mock from a saved version or a test run, then call again.`
    );
  }
  const operation = bindOperation(name, state, input);
  if (!operation.ok) {
    report("invalid_input");
    return toolErrorResult(operation.message);
  }
  let write: MockRecordWrite | undefined;
  const writes = state.op !== "get" && state.op !== "list";
  if (writes) {
    const found = operationKeyOf(call.meta);
    if ("error" in found) {
      report("invalid_input");
      return toolErrorResult(found.error);
    }
    if (found.key !== undefined) {
      write = { key: found.key, fingerprint: fingerprintToolCall(name, input) };
    }
  }
  let outcome: Awaited<ReturnType<MockRecords["store"]["execute"]>>;
  try {
    outcome = await call.records.store.execute(
      call.records.context,
      operation.value,
      write
    );
  } catch (error) {
    if (!(error instanceof MockRecordRefusedError)) throw error;
    report("record_refused");
    return toolErrorResult(error.message);
  }
  if (!outcome.ok) {
    report("record_refused");
    return toolErrorResult(recordRefusal(name, state, outcome.code));
  }
  const shaped = shapeResult(name, state, outcome, input);
  if (!shaped.ok) {
    report("invalid_output");
    return toolErrorResult(shaped.message);
  }
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(shaped.value) }],
    structuredContent: shaped.value,
  };
  const output = checkStructuredOutput(call.tool?.outputSchema, result);
  if (!output.ok) {
    report("invalid_output");
    return toolErrorResult(
      `The result of ${name} does not match its output schema: ${output.message}.${writes ? " The change was saved." : ""} Fix the result template, or the output schema.`
    );
  }
  report();
  return result;
}
