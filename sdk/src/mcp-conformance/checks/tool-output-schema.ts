/**
 * Grading for Tool Output Schema Conformant: does a tool's result honor the
 * `outputSchema` the tool declares?
 *
 * "If an output schema is provided: Servers **MUST** provide structured results
 * that conform to this schema." The sentence is in 2025-06-18, 2025-11-25 and
 * 2026-07-28 alike, so the grading lives here, apart from how any one revision
 * lists tools and calls them. Each revision hands it a {@link ToolOutputSchemaProbe}.
 */

import { DialectAwareJsonSchemaValidator } from "../../mcp-client-manager/dialect-aware-json-schema-validator.js";
import { needsSetupDetails } from "../../conformance-input.js";
import type { MCPCheckResult, RawHttpCheckContext } from "../types.js";
import type { RawHttpResult } from "../raw-http.js";
import { jsonRpcError, jsonRpcResult } from "../raw-http.js";
import {
  couldNotRunResult,
  failedResult,
  notApplicableResult,
  passedResult,
} from "./helpers.js";

type CheckMeta = Pick<MCPCheckResult, "id" | "category" | "title" | "description">;

/** One `tools/call` the operator said is safe to make. */
export type ToolCallFixture =
  RawHttpCheckContext["config"]["fixtures"]["toolCalls"][number];

/** What the grading needs from the revision it runs on. */
export interface ToolOutputSchemaProbe {
  /** The calls the operator named. */
  fixtures: readonly ToolCallFixture[];
  /** Tool name to the `outputSchema` it declares. */
  declared: Map<string, unknown>;
  /** Whether `declared` was read from the whole listing. */
  complete: boolean;
  /** Make one call, the way a conforming client of this revision does. */
  callTool: (fixture: ToolCallFixture, id: number) => Promise<RawHttpResult>;
  /**
   * The setup-gap verdict when the arguments do not fit the tool's own
   * `inputSchema`, else `undefined`.
   */
  badArgs: (
    toolName: string,
    args: Record<string, unknown> | undefined,
    httpStatus: number
  ) => Promise<MCPCheckResult | undefined>;
}

/**
 * FIXTURE-GATED, and unavoidably so. The obligation binds a value the server
 * only produces by EXECUTING the tool, and nothing in a tool's advertised
 * metadata says whether executing it is safe. So the operator names the calls
 * that are safe. Without one, the check is NOT APPLICABLE only when no tool
 * declares an `outputSchema`; when one does, the MUST went unverified, so it
 * could not run.
 */
export async function gradeToolOutputSchemas(
  meta: CheckMeta,
  startedAt: number,
  probe: ToolOutputSchemaProbe
): Promise<MCPCheckResult> {
  const { fixtures, declared, complete } = probe;
  if (fixtures.length === 0) {
    // "No tool declares one" holds only over the whole listing: a walk cut
    // short may have stopped before the tool that does.
    return declared.size === 0 && complete
      ? notApplicableResult(
          meta,
          "No tool declares an outputSchema, so there is no structured result to check"
        )
      : couldNotRunResult(
          meta,
          declared.size === 0
            ? "The tools/list walk did not finish, so it could not show that no tool declares an outputSchema, and no tools/call fixture was configured"
            : `${declared.size} tool(s) declare an outputSchema, but no tools/call fixture was configured: set fixtures.toolCalls to a tool that is safe to execute so its result can be checked against the schema`,
          {
            declaredOutputSchemas: [...declared.keys()],
            ...(declared.size > 0 ? { missingInput: "toolCallProbe" } : {}),
          }
        );
  }
  // The validator accepts every value under a dialect it does not support, so
  // a result "validated" against such a schema was never checked. Remember
  // those dialects: the default handler would only console.warn, and a
  // conformance run reports, it does not print.
  const unsupportedDialects = new Set<string>();
  const validator = new DialectAwareJsonSchemaValidator({
    onUnknownDialect: (dialect) => {
      unsupportedDialects.add(dialect);
    },
  });

  const problems: string[] = [];
  /** Results that an output schema binds but this check could not validate. */
  const unvalidated: UnvalidatedToolResult[] = [];
  // `schemaBound` is the load-bearing field, not the prose: it records whether
  // an output schema actually GRADED this result. Deriving that from the
  // outcome text would make a reworded message silently change the verdict.
  const graded: Array<{
    tool: string;
    outcome: string;
    schemaBound: boolean;
  }> = [];
  /**
   * Fixtures that never produced a gradeable result. These are reported as an
   * UNEXERCISED requirement, not as a server violation — see the JSON-RPC-error
   * branch below.
   */
  const unexercised: string[] = [];
  /**
   * Who a fixture that produced nothing gradeable points at: the caller's
   * setup (no output schema on the tool, or arguments its own schema rejects)
   * or the server (the tool failed on arguments that fit). Only a server-side
   * miss keeps this check yellow at a cost; the rest is setup to change.
   */
  let serverMiss = false;
  let badArgsMessage: string | undefined;
  const classifyFailedCall = async (
    toolName: string,
    args: Record<string, unknown> | undefined,
    httpStatus: number
  ) => {
    const badArgs = await probe.badArgs(toolName, args, httpStatus);
    if (badArgs) badArgsMessage ??= badArgs.error?.message;
    else serverMiss = true;
  };
  let id = 7950;

  for (const fixture of fixtures) {
    const outputSchema = declared.get(fixture.toolName);
    const result = await probe.callTool(fixture, id++);

    if (outputSchema === undefined) {
      // Still worth calling: the frame reaches the run-wide wire record, so
      // `wire-schema-valid` grades it against `CallToolResult` — a result shape
      // an unfixtured run never observes at all.
      graded.push({
        tool: fixture.toolName,
        outcome: "no outputSchema declared; nothing to validate against",
        schemaBound: false,
      });
      continue;
    }

    const payload = jsonRpcResult(result);
    if (!payload) {
      const error = jsonRpcError(result);
      // NOT a server violation. A JSON-RPC error here means the call never
      // produced a result to grade — and the likeliest cause is the FIXTURE:
      // arguments the operator supplied that the tool's inputSchema rejects
      // (`-32602`), a tool name that does not resolve (`-32601`), an auth
      // scope the run lacks. Counting it as a `problem` would fail the check —
      // "tool results do not honor their declared output schemas" — and brand
      // the server nonconformant for correctly refusing a request this suite
      // built badly. The requirement simply went untested, which is what
      // `unexercised` reports; the `isError: true` branch below draws the same
      // line for the tool-level case.
      unexercised.push(
        `${fixture.toolName} produced no result to validate (HTTP ${result.status}${
          error ? `, JSON-RPC ${error.code}: ${error.message}` : ""
        }); check the fixture's tool name and arguments against the tool's inputSchema`
      );
      await classifyFailedCall(fixture.toolName, fixture.arguments, result.status);
      continue;
    }
    // An `isError: true` result reports a TOOL failure, which is a normal
    // outcome the server is entitled to return — and the spec's own example of
    // one carries no `structuredContent`. Grading it against the output schema
    // would fail servers for correctly reporting that the weather API was down.
    if (payload.isError === true) {
      graded.push({
        tool: fixture.toolName,
        outcome: "tool reported isError: true; output schema does not bind",
        schemaBound: false,
      });
      await classifyFailedCall(fixture.toolName, fixture.arguments, result.status);
      continue;
    }

    const structured = payload.structuredContent;
    if (structured === undefined) {
      problems.push(
        `${fixture.toolName} declares an outputSchema but returned no structuredContent`
      );
      continue;
    }

    const validate = validator.getValidator(
      outputSchema as Parameters<typeof validator.getValidator>[0]
    );
    const dialect = declaredDialect(outputSchema);
    if (dialect !== undefined && unsupportedDialects.has(dialect)) {
      unvalidated.push({ tool: fixture.toolName, dialect });
      graded.push({
        tool: fixture.toolName,
        outcome: `outputSchema declares JSON Schema dialect ${dialect}, which this check cannot validate; result not checked`,
        schemaBound: false,
      });
      continue;
    }
    const outcome = validate(structured);
    if (!outcome.valid) {
      problems.push(
        `${fixture.toolName} structuredContent does not conform to its declared outputSchema: ${
          outcome.errorMessage ?? "validation failed"
        }`
      );
      continue;
    }
    graded.push({
      tool: fixture.toolName,
      outcome: "structuredContent conforms",
      schemaBound: true,
    });
  }

  const withSchema = graded.filter((entry) => entry.schemaBound).length;
  const details = {
    graded,
    problems,
    fixtureCount: fixtures.length,
    ...(unexercised.length > 0 ? { unexercised } : {}),
  };

  if (problems.length > 0) {
    return failedResult(
      meta,
      Date.now() - startedAt,
      `Tool results do not honor their declared output schemas: ${problems.join("; ")}`,
      details
    );
  }

  // A result whose schema this check cannot read was never checked. The server
  // did nothing wrong (a schema MAY declare another dialect), so it costs no
  // point; and nothing showed the result conforms, so it is not a pass either,
  // even when another fixture was graded.
  if (unvalidated.length > 0) {
    const text = unsupportedDialectMessage(unvalidated);
    return couldNotRunResult(meta, text, {
      ...details,
      unsupportedDialects: unvalidated,
      ...needsSetupDetails("toolCallProbe", text),
    });
  }

  // Nothing was gradeable AND at least one fixture failed to execute: the
  // requirement went untested for a reason that points at the fixture, so say
  // so rather than reporting the generic never-bound message.
  // Nothing gradeable, and nothing the server is to blame for: the fixtures
  // picked tools with no output schema, or gave arguments their own schema
  // rejects. That is setup to change, so it costs no point.
  if (withSchema === 0 && !serverMiss) {
    const text =
      badArgsMessage ??
      "Your test tools have no output schema, so there was nothing to check. Pick a tool that has one, then run again.";
    return couldNotRunResult(
      meta,
      unexercised.length > 0
        ? `No tool fixture produced a gradeable result: ${unexercised.join("; ")}`
        : `None of the ${fixtures.length} configured tool fixture(s) produced a result bound by a declared outputSchema, so the requirement was never exercised (${graded
            .map((entry) => `${entry.tool}: ${entry.outcome}`)
            .join("; ")}). Their results still widened the wire-schema coverage.`,
      { ...details, ...needsSetupDetails("toolCallProbe", text) }
    );
  }

  if (withSchema === 0 && unexercised.length > 0) {
    return couldNotRunResult(
      meta,
      `No tool fixture produced a gradeable result: ${unexercised.join("; ")}`,
      details
    );
  }

  if (withSchema === 0) {
    // Every fixture ran and nothing was ever BOUND by an output schema —
    // because none declared one, or because the ones that did reported
    // `isError: true`, which the schema does not bind. A pass would claim the
    // MUST was established when it was never exercised.
    return couldNotRunResult(
      meta,
      `None of the ${fixtures.length} configured tool fixture(s) produced a result bound by a declared outputSchema, so the requirement was never exercised (${graded
        .map((entry) => `${entry.tool}: ${entry.outcome}`)
        .join("; ")}). Their results still widened the wire-schema coverage.`,
      details
    );
  }

  return passedResult(meta, Date.now() - startedAt, details);
}

interface UnvalidatedToolResult {
  tool: string;
  dialect: string;
}

/** The `$schema` a tool's output schema declares, exactly as written. */
function declaredDialect(outputSchema: unknown): string | undefined {
  if (outputSchema === null || typeof outputSchema !== "object") {
    return undefined;
  }
  const dialect = (outputSchema as { $schema?: unknown }).$schema;
  return typeof dialect === "string" ? dialect : undefined;
}

/** The plain fix shown when a picked tool's output schema could not be read. */
function unsupportedDialectMessage(
  unvalidated: UnvalidatedToolResult[]
): string {
  const tools = unvalidated
    .map(({ tool, dialect }) => `"${tool}" (${dialect})`)
    .join(", ");
  return `This check reads output schemas written in JSON Schema 2020-12 or draft-07. It could not read the output schema of ${tools}, so ${
    unvalidated.length === 1 ? "that result was" : "those results were"
  } not checked. Pick a tool whose output schema uses 2020-12 or draft-07, then run again.`;
}
