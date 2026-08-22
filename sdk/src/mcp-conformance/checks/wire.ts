/**
 * `wire-schema-valid` — grade every message this run observed against the
 * spec's own JSON Schema for the revision being spoken.
 *
 * Why this is one check and not thirty: the schema already states every
 * structural requirement the revision makes, so enumerating them as individual
 * checks would be re-typing the specification by hand — which is precisely how
 * our pool ended up asserting two cache fields while the official suite's
 * single schema check found 74 violations we never asked about.
 *
 * It runs LAST, after every other family, because it is the only check whose
 * subject is the run itself rather than a probe of its own. It sends no
 * request: it reads what the other families already made the server say (see
 * `wire-observations.ts`). That is also why it is cheap — a whole extra family
 * of assertions for zero extra traffic.
 *
 * ERA-NEUTRAL. Each revision ships its own schema, so the check means the same
 * thing on a 2025 pin as on a 2026 one; only the document changes. The 2025
 * documents are far more permissive, which is a fact about those revisions,
 * not a weakness here.
 */

import type {
  MCPCheckId,
  MCPCheckResult,
  RawHttpCheckContext,
} from "../types.js";
import { CHECK_ERAS } from "../types.js";
import {
  eraSkipMessage,
  failedResult,
  passedResult,
  couldNotRunResult,
  notApplicableResult,
} from "./helpers.js";
import { drivePromptFixtures } from "./modern.js";
import { WireSchemaValidator } from "../wire-schema.js";
import type { WireObservationRecorder } from "../wire-observations.js";
import type { WireSchemaValidationReport } from "../wire-schema.js";

export const WIRE_SCHEMA_CHECK_ID = "wire-schema-valid" as const;

export const WIRE_CHECK_METADATA = {
  "wire-schema-valid": {
    id: WIRE_SCHEMA_CHECK_ID,
    category: "protocol",
    title: "Wire Schema Valid",
    description:
      "Every JSON-RPC message the run observed validates against the protocol revision's published JSON Schema, with responses graded against their method's result definition.",
  },
} as const;

/** How many violations a failure message spells out before summarizing. */
const MAX_REPORTED_VIOLATIONS = 10;

/**
 * The result of the run's schema pass, handed back so the runner can stamp the
 * schema digest into the profile — a score is only comparable to another if
 * the documents behind it were the same.
 */
export interface WireSchemaCheckOutcome {
  results: MCPCheckResult[];
  report?: WireSchemaValidationReport;
}

export async function runWireSchemaCheck(
  ctx: RawHttpCheckContext,
  selectedCheckIds: Set<MCPCheckId>,
  recorder: WireObservationRecorder,
): Promise<WireSchemaCheckOutcome> {
  const meta = WIRE_CHECK_METADATA["wire-schema-valid"];
  if (!selectedCheckIds.has(WIRE_SCHEMA_CHECK_ID)) {
    return { results: [] };
  }
  if (!CHECK_ERAS[WIRE_SCHEMA_CHECK_ID].includes(ctx.config.era)) {
    return {
      results: [
        notApplicableResult(
          meta,
          eraSkipMessage(ctx.config.era, ctx.config.protocolVersion),
        ),
      ],
    };
  }

  const startedAt = Date.now();
  const protocolVersion = ctx.config.protocolVersion;
  if (protocolVersion === undefined) {
    // A raw-only run that never connected established no revision. Guessing
    // one would grade the server against a schema it never agreed to speak.
    return {
      results: [
        couldNotRunResult(
          meta,
          "The run established no protocol version (no client connection and no pin), so there is no revision whose schema to validate against",
        ),
      ],
    };
  }

  // Populate the record with the operator's `prompts/get` fixtures before
  // reading it. They assert nothing on their own — every structural
  // requirement on a `GetPromptResult` is stated by the revision's schema, and
  // this check already grades that. What they do is make the frame EXIST: an
  // unfixtured run never issues a `prompts/get` with real arguments, so
  // `GetPromptResult` is a shape our conformance path has never once looked at.
  //
  // Swallowed on failure, because a fixture that turns out not to work must not
  // take down a check that had other traffic to grade.
  let promptFixturesDriven = 0;
  let promptFixtureError: string | undefined;
  try {
    promptFixturesDriven = await drivePromptFixtures(ctx);
  } catch (error) {
    // Those frames simply do not appear in the record. Swallowing the failure
    // is right; hiding it is not — an operator whose fixtures silently did
    // nothing needs the reason in the report, not a coverage number that is
    // quietly zero.
    promptFixtureError = error instanceof Error ? error.message : String(error);
  }

  const observations = recorder.observations;
  if (observations.length === 0) {
    return {
      results: [
        couldNotRunResult(
          meta,
          "No JSON-RPC message was observed on the wire, so there was nothing to validate",
        ),
      ],
    };
  }

  const validator = new WireSchemaValidator({
    protocolVersion,
    extensionIds: negotiatedExtensionIds(ctx),
  });
  const report = validator.validate(observations);

  const details = {
    protocolVersion,
    extensionIds: report.extensionIds,
    schemaDigest: report.schemaDigest,
    messagesValidated: report.validated,
    // The honest coverage number. A run where nothing correlated graded every
    // message against the near-vacuous envelope union, and a reader has to be
    // able to see that rather than read a pass as a strong statement.
    methodCorrelated: report.correlated,
    violationCount: report.violations.length,
    promptFixturesDriven,
    ...(promptFixtureError ? { promptFixtureError } : {}),
  };

  if (report.violations.length === 0) {
    return {
      results: [passedResult(meta, Date.now() - startedAt, details)],
      report,
    };
  }

  const shown = report.violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const overflow = report.violations.length - shown.length;
  const message = `${report.violations.length} observed message(s) do not match the ${protocolVersion} schema: ${shown
    .map(
      (violation) =>
        `${violation.origin} [${violation.definition}] ${violation.errors.join("; ")}`,
    )
    .join(" | ")}${overflow > 0 ? ` (+${overflow} more)` : ""}`;

  return {
    results: [
      failedResult(meta, Date.now() - startedAt, message, {
        ...details,
        violations: report.violations,
      }),
    ],
    report,
  };
}

/**
 * Extensions the run negotiated, read off the capabilities the client phase
 * captured. Absent surface ⇒ none: composing an extension schema the server
 * never declared would ACCEPT results it is not entitled to send.
 */
function negotiatedExtensionIds(ctx: RawHttpCheckContext): string[] {
  const capabilities = ctx.surface?.serverCapabilities;
  if (!capabilities) return [];
  const extensions = capabilities.extensions;
  if (extensions === null || typeof extensions !== "object") return [];
  return Object.keys(extensions as Record<string, unknown>);
}
