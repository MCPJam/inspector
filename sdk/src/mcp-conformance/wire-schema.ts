/**
 * Wire-schema validation: does what the server actually sent match the spec's
 * own JSON Schema for the revision it is speaking?
 *
 * THIS IS THE GAP THE SWEEP FOUND. Our conformance pool asserted individual
 * fields it had thought to name — and abstained on seven of nine production
 * connectors — while the official suite's `wire-schema-valid` found 74 real
 * violations on six of nine: `tools/list` results missing the REQUIRED
 * `cacheScope` / `resultType` / `ttlMs`, and response envelopes carrying
 * `"id": null` where `RequestId` is `["string", "integer"]`. A hand-written
 * field check can only catch what its author remembered; the schema is the
 * complete statement.
 *
 * CORRELATION IS WHAT MAKES IT NON-VACUOUS. `ServerResult` includes a branch
 * for the base `Result`, which requires only `resultType` and allows every
 * other property. Validating a `tools/list` response against the generic
 * `JSONRPCMessage` union therefore accepts a result missing `ttlMs` and
 * `cacheScope` — the exact defect the sweep found. Selecting `ListToolsResult`
 * because the observation says it answers `tools/list` is the whole value; the
 * generic union is only the fallback for a message we could not attribute.
 *
 * THE METHOD → RESULT MAP IS DERIVED, NOT TYPED OUT. Each schema names its
 * request definitions with a `method` const (`ListToolsRequest` ⇒
 * `"tools/list"`), and the matching result is the same name with
 * `Request` ⇒ `Result`. Deriving it means a revision that renames a method
 * cannot leave a stale hand-written table behind — the map moves when the
 * vendored schema moves.
 *
 * EXTENSION-AWARE. When the tasks extension is in play, `tools/call` may
 * legitimately answer with a `CreateTaskResult`, which the CORE schema's
 * `CallToolResult` (it requires `content`) rejects. The target then becomes
 * `anyOf: [core CallToolResult, ext-tasks CreateTaskResult]` — composed across
 * two registered documents rather than by inlining, because each document's
 * internal `$ref`s are relative to its own root.
 *
 * NODE-ONLY. Ajv compiles with `new Function`, which is CSP-hostile in a
 * browser and broken outright on workerd — the same reason
 * `dialect-aware-json-schema-validator.ts` keeps its engines out of the
 * browser entry. This module is reachable only from the conformance runner,
 * which is already Node-only.
 */

import { Ajv2020 } from "ajv/dist/2020.js";
import AjvDraft07 from "ajv";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { MCP_TASKS_EXTENSION_ID } from "../mcp-client-manager/tasks-dispatch.js";
import type { McpProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import {
  CORE_WIRE_SCHEMAS,
  EXTENSION_SCHEMA_REVISIONS,
  EXTENSION_WIRE_SCHEMAS,
  definitionsPointer,
  type WireSchemaDocument,
} from "./schemas/index.js";
import type { ObservedWireMessage } from "./wire-observations.js";

/** `$id` under which a document is registered. Opaque; never dereferenced. */
const CORE_SCHEMA_ID = "mcpjam:conformance/core";
const EXTENSION_SCHEMA_ID_PREFIX = "mcpjam:conformance/ext/";

/**
 * The tasks extension id, re-exported rather than re-spelled: a second literal
 * that must match the dispatch layer's is a literal that will eventually not.
 */
export const TASKS_EXTENSION_ID = MCP_TASKS_EXTENSION_ID;

/**
 * 2020-12 vs draft-07: 2025-03-26 and 2025-06-18 declare draft-07, the later
 * two declare 2020-12. Ajv's two engines are not interchangeable — compiling a
 * draft-07 document on the 2020-12 engine silently mis-handles `definitions`
 * and `$ref` resolution — so the engine is chosen from the DOCUMENT, never
 * from the revision date.
 */
const DRAFT_07_URIS = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
]);

function isDraft07(document: WireSchemaDocument): boolean {
  const declared =
    typeof document.$schema === "string"
      ? document.$schema.replace(/#$/, "")
      : undefined;
  return declared !== undefined && DRAFT_07_URIS.has(declared);
}

/** Minimal surface both Ajv engines share, so the two are interchangeable here. */
interface SchemaEngine {
  addSchema(schema: object): unknown;
  compile(schema: object): ValidateFn;
}

interface ValidateFn {
  (data: unknown): boolean;
  errors?: Array<{
    instancePath?: string;
    schemaPath?: string;
    keyword?: string;
    message?: string;
    params?: Record<string, unknown>;
  }> | null;
}

function createEngine(draft07: boolean): SchemaEngine {
  const options = {
    // Mirrors the client-side validators: the vendored documents use keywords
    // Ajv's strict mode rejects, and a conformance run must validate the spec
    // as published rather than a stricter reading of it.
    strict: false,
    validateSchema: false,
    // Every violation, not the first: a report that names one missing field
    // per result would take six runs to surface the six the sweep found.
    allErrors: true,
    // NO `ajv-formats`, deliberately. `format` is an ANNOTATION in JSON Schema
    // 2020-12 unless a vocabulary makes it assertive, and the spec schemas use
    // `format: "uri"` / `"byte"` descriptively. Registering the assertions
    // would fail servers for shapes the specification does not require — a
    // conformance check inventing requirements is worse than one missing them.
    // `logger: false` silences Ajv's per-format "ignored" notice, which is
    // otherwise emitted hundreds of times per run for a decision we made.
    logger: false as const,
  };
  // `AjvDraft07` is a CJS default export; the interop shape differs between
  // the bundled and source paths, so resolve it defensively rather than
  // depending on which one a given consumer loaded.
  const Draft07Ctor = ((AjvDraft07 as unknown as { default?: unknown })
    .default ?? AjvDraft07) as new (opts: object) => SchemaEngine;
  return draft07 ? new Draft07Ctor(options) : (new Ajv2020(options) as unknown as SchemaEngine);
}

/** What a message was validated against, and whether it held. */
export interface WireSchemaViolation {
  /** `POST tools/list`, `subscriptions/listen frame`, … */
  origin: string;
  /** The schema definition the message was graded against. */
  definition: string;
  /** The message's own JSON-RPC id, when it carried one. */
  id?: string | number | null;
  /** One line per failing keyword, in Ajv's vocabulary. */
  errors: string[];
}

export interface WireSchemaValidationReport {
  /** Revision whose schema was used. */
  protocolVersion: McpProtocolVersion;
  /** Extension ids composed into the targets. */
  extensionIds: string[];
  /** Extension id → the schema revision validated against. */
  extensionRevisions: Record<string, string>;
  /** SHA-256 over the exact documents used, for the profile stamp. */
  schemaDigest: string;
  /** How many observed messages were graded. */
  validated: number;
  /** How many were graded against a METHOD-SPECIFIC definition. */
  correlated: number;
  violations: WireSchemaViolation[];
}

/**
 * The document's error-response definition. The name moved across revisions
 * (`JSONRPCError` through 2025-06-18, `JSONRPCErrorResponse` from 2025-11-25),
 * so it is read off the document rather than assumed.
 */
function errorResponseDefinition(
  document: WireSchemaDocument,
): string | undefined {
  const { definitions } = definitionsPointer(document);
  for (const name of ["JSONRPCErrorResponse", "JSONRPCError"]) {
    if (definitions[name] !== undefined) return name;
  }
  return undefined;
}

/** A method's result definition and the `$ref` that resolves it. */
interface ResultTarget {
  definition: string;
  ref: string;
}

/**
 * The `method` const of a request definition, wherever it is declared.
 *
 * The core documents put it directly under `properties`, but the ext-tasks
 * document composes each request as `allOf: [{$ref: JSONRPCRequest}, {…}]` and
 * declares `method` in the second branch. Reading only the top level found NO
 * method for `tasks/get`, `tasks/update` or `tasks/cancel`, so their results
 * were never correlated — they fell back to the near-vacuous envelope union and
 * silently contributed nothing to `correlated`, on the extension whose result
 * shapes are the least covered elsewhere.
 */
function methodConstOf(definition: unknown): string | undefined {
  if (definition === null || typeof definition !== "object") return undefined;
  const node = definition as {
    properties?: { method?: { const?: unknown } };
    allOf?: unknown[];
  };
  const direct = node.properties?.method?.const;
  if (typeof direct === "string") return direct;
  for (const branch of node.allOf ?? []) {
    const nested = methodConstOf(branch);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Method → result definition name, derived from the document's own request
 * definitions. A method whose request definition has no `…Result` sibling
 * (`logging/setLevel`, `resources/subscribe`) is absent: those answer the base
 * empty result, and pinning them to a definition that does not exist would
 * make Ajv fail to COMPILE, i.e. break the check rather than catch a server.
 */
function deriveResultDefinitions(
  document: WireSchemaDocument,
  schemaId: string,
): Map<string, ResultTarget> {
  const { key, definitions } = definitionsPointer(document);
  const map = new Map<string, ResultTarget>();
  for (const [name, definition] of Object.entries(definitions)) {
    if (!name.endsWith("Request")) continue;
    const method = methodConstOf(definition);
    if (typeof method !== "string") continue;
    const resultName = `${name.slice(0, -"Request".length)}Result`;
    if (definitions[resultName] !== undefined) {
      // The `$ref` travels with the name: an extension declares its methods in
      // ITS document, so resolving them against the core schema id would either
      // fail to compile or grade against the wrong definition.
      map.set(method, {
        definition: resultName,
        ref: `${schemaId}#/${key}/${resultName}`,
      });
    }
  }
  return map;
}

function describeError(error: {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: Record<string, unknown>;
}): string {
  const where = error.instancePath ? error.instancePath : "(root)";
  const params =
    error.params && Object.keys(error.params).length > 0
      ? ` ${JSON.stringify(error.params)}`
      : "";
  return `${where} ${error.message ?? error.keyword ?? "is invalid"}${params}`;
}

/**
 * A validator bound to one revision and one set of negotiated extensions.
 * Compiled targets are memoized: a run observes many messages per method, and
 * Ajv compilation is the expensive half.
 */
export class WireSchemaValidator {
  private readonly engine: SchemaEngine;
  private readonly defsKey: "definitions" | "$defs";
  private readonly resultDefinitions: Map<string, ResultTarget>;
  private readonly errorResponseDefinition?: string;
  private readonly compiled = new Map<string, ValidateFn>();
  private readonly extensionResultOverrides: Map<string, string[]>;

  readonly protocolVersion: McpProtocolVersion;
  readonly extensionIds: string[];
  readonly schemaDigest: string;

  constructor(options: {
    protocolVersion: McpProtocolVersion;
    /** Extension ids the run negotiated. Unknown ids are ignored, not an error. */
    extensionIds?: readonly string[];
  }) {
    this.protocolVersion = options.protocolVersion;
    const core = CORE_WIRE_SCHEMAS[options.protocolVersion];
    this.engine = createEngine(isDraft07(core));
    this.defsKey = definitionsPointer(core).key;
    this.resultDefinitions = deriveResultDefinitions(core, CORE_SCHEMA_ID);
    this.errorResponseDefinition = errorResponseDefinition(core);
    this.engine.addSchema({ ...core, $id: CORE_SCHEMA_ID });

    const digestParts: string[] = [
      `${options.protocolVersion}:${stableDigest(core)}`,
    ];
    const extensionIds: string[] = [];
    this.extensionResultOverrides = new Map();

    for (const id of options.extensionIds ?? []) {
      const extension = EXTENSION_WIRE_SCHEMAS[id];
      if (!extension) continue;
      // A draft-07 core with a 2020-12 extension cannot share one engine, and
      // no such pairing exists today (tasks is 2026-only). Skipping is the
      // honest response: composing across engines would validate the extension
      // branch under the wrong dialect.
      if (isDraft07(core) !== isDraft07(extension)) continue;
      const schemaId = `${EXTENSION_SCHEMA_ID_PREFIX}${id}`;
      this.engine.addSchema({ ...extension, $id: schemaId });
      extensionIds.push(id);
      digestParts.push(`${id}:${stableDigest(extension)}`);
      // Methods the EXTENSION declares (`tasks/get`, `tasks/update`,
      // `tasks/cancel`). The core document knows nothing about them, so without
      // this their results are graded against the near-vacuous envelope union —
      // no correlation at all, on exactly the surface nothing else covers.
      // A method the core already declares keeps the core's definition.
      for (const [method, target] of deriveResultDefinitions(
        extension,
        schemaId,
      )) {
        if (!this.resultDefinitions.has(method)) {
          this.resultDefinitions.set(method, target);
        }
      }
      if (id === TASKS_EXTENSION_ID) {
        // A task-eligible `tools/call` answers EITHER normally or with a
        // `CreateTaskResult`. Both are conforming; grading only the first
        // would fail every server that actually implements the extension.
        //
        // The pointer segment is read off the extension document, not the core
        // one and not hardcoded: an extension may be published under a
        // different dialect than the revision it extends, and a `$ref` into the
        // wrong keyword makes Ajv fail to compile.
        const extensionDefsKey = definitionsPointer(extension).key;
        this.extensionResultOverrides.set("tools/call", [
          `${schemaId}#/${extensionDefsKey}/CreateTaskResult`,
        ]);
      }
    }

    this.extensionIds = extensionIds;
    this.schemaDigest = bytesToHex(
      sha256(utf8ToBytes(digestParts.join("|"))),
    );
  }

  private compileRef(refs: string[], cacheKey: string): ValidateFn {
    const cached = this.compiled.get(cacheKey);
    if (cached) return cached;
    const schema =
      refs.length === 1
        ? { $ref: refs[0] }
        : { anyOf: refs.map((ref) => ({ $ref: ref })) };
    const validate = this.engine.compile(schema);
    this.compiled.set(cacheKey, validate);
    return validate;
  }

  /**
   * The schema target for one observation: the method-specific result when the
   * message answers a request we can attribute, the generic message union
   * otherwise.
   */
  private targetFor(observation: ObservedWireMessage): {
    definition: string;
    refs: string[];
    /**
     * Grade the message with its `id` member removed. Set only for the
     * undeterminable-id error case below; the error object, `jsonrpc`, and
     * every other member are still graded in full.
     */
    dropId?: boolean;
  } {
    const record =
      observation.message !== null && typeof observation.message === "object"
        ? (observation.message as Record<string, unknown>)
        : undefined;

    // An error response is an error response whatever it answers: grading it
    // against `ListToolsResult` would report every legitimate in-band error as
    // a schema violation.
    const isErrorResponse = record !== undefined && "error" in record;
    const isResultResponse =
      record !== undefined && "result" in record && !isErrorResponse;

    const resultDefinition = observation.requestMethod
      ? this.resultDefinitions.get(observation.requestMethod)
      : undefined;

    if (isResultResponse && resultDefinition) {
      const method = observation.requestMethod as string;
      const refs = [
        resultDefinition.ref,
        ...(this.extensionResultOverrides.get(method) ?? []),
      ];
      return { definition: resultDefinition.definition, refs };
    }

    // JSON-RPC 2.0 REQUIRES `id: null` on an error whose request id could not
    // be detected — a parse error, an invalid request. `RequestId` is
    // `["string","integer"]` and does not model that, so grading such a
    // response against the envelope union would fail a server for doing
    // exactly what the base protocol mandates. The raw track sends malformed
    // frames on purpose, so this is not a corner case here.
    //
    // Narrow on purpose: it applies ONLY when the request genuinely had no
    // detectable id. A server that drops an id it was handed still fails, which
    // is the defect the 2026-07 sweep found in the wild.
    if (
      isErrorResponse &&
      record?.id === null &&
      observation.requestIdDeterminable !== true &&
      this.errorResponseDefinition !== undefined
    ) {
      return {
        definition: `${this.errorResponseDefinition} (id undeterminable)`,
        refs: [
          `${CORE_SCHEMA_ID}#/${this.defsKey}/${this.errorResponseDefinition}`,
        ],
        dropId: true,
      };
    }

    return {
      definition: "JSONRPCMessage",
      refs: [`${CORE_SCHEMA_ID}#/${this.defsKey}/JSONRPCMessage`],
    };
  }

  /**
   * The envelope MEMBERS of a response whose result is being graded against a
   * method-specific definition. Without this, correlation traded envelope
   * coverage for payload coverage instead of adding to it.
   *
   * Deliberately NOT the whole frame against `JSONRPCMessage`: that union's
   * response branch re-validates `result`, so a bad payload also came back as
   * "must match a schema in anyOf" plus a duplicate of every payload error —
   * noise that buries the envelope fact the reader needs. This grades exactly
   * the two members the payload schema does not cover, and takes `id`'s shape
   * from the document's own `RequestId` rather than restating it.
   */
  private validateEnvelope(observation: ObservedWireMessage): string[] {
    const validate = this.compileEnvelope();
    if (validate(observation.message)) return [];
    return (validate.errors ?? []).map(
      (error) => `envelope: ${describeError(error)}`,
    );
  }

  private compileEnvelope(): ValidateFn {
    const cacheKey = "envelope-members";
    const cached = this.compiled.get(cacheKey);
    if (cached) return cached;
    const validate = this.engine.compile({
      type: "object",
      properties: {
        jsonrpc: { const: "2.0" },
        id: { $ref: `${CORE_SCHEMA_ID}#/${this.defsKey}/RequestId` },
      },
      required: ["jsonrpc", "id"],
    });
    this.compiled.set(cacheKey, validate);
    return validate;
  }

  validate(
    observations: readonly ObservedWireMessage[],
  ): WireSchemaValidationReport {
    const violations: WireSchemaViolation[] = [];
    let correlated = 0;

    for (const observation of observations) {
      const target = this.targetFor(observation);
      const isMethodSpecific =
        this.resultDefinitions.get(observation.requestMethod ?? "")
          ?.definition === target.definition;
      if (isMethodSpecific) correlated += 1;

      // The id echo, which no schema can state: `RequestId` admits both a
      // string and an integer, so `{"id": "1"}` answering `{"id": 1}` is
      // schema-valid and still wrong — "the response MUST contain the same ID
      // as the request", and those are different JSON values. The recorder
      // pairs them anyway so correlation is not lost against a sloppy server;
      // reporting it here is what stops that tolerance from swallowing the
      // defect.
      if (observation.idEchoMismatch) {
        const { sent, echoed } = observation.idEchoMismatch;
        violations.push({
          origin: observation.origin,
          definition: "JSON-RPC id echo",
          id: observation.id,
          errors: [
            `response echoed id ${JSON.stringify(echoed)} (${typeof echoed}) for a request that sent ${JSON.stringify(sent)} (${typeof sent}); the id must be echoed unchanged, and these are different JSON values`,
          ],
        });
      }

      // A method-specific target grades the RESULT payload, which is where the
      // required members live; everything else is graded as a whole envelope.
      const subject = isMethodSpecific
        ? (observation.message as Record<string, unknown>).result
        : target.dropId
          ? withPlaceholderId(observation.message)
          : observation.message;

      const validate = this.compileRef(
        target.refs,
        `${target.definition}:${target.refs.join("+")}`,
      );
      const errors = validate(subject)
        ? []
        : (validate.errors ?? []).map(describeError);

      // Correlation must not make the check WEAKER. Grading only `result` left
      // the envelope of every correlated response ungraded — so a `tools/list`
      // answer carrying `jsonrpc: "1.0"`, or the `id: null` this suite exists to
      // catch, passed silently. It is caught today only because the canva
      // defect happens to ride an ERROR response, which takes the envelope
      // path. The envelope is graded too, and the two error sets are reported
      // together so the reader sees both halves of one frame.
      const envelopeErrors = isMethodSpecific
        ? this.validateEnvelope(observation)
        : [];

      if (errors.length === 0 && envelopeErrors.length === 0) continue;

      violations.push({
        origin: observation.origin,
        definition: target.definition,
        ...(observation.id !== undefined ? { id: observation.id } : {}),
        errors: [...errors, ...envelopeErrors],
      });
    }

    return {
      protocolVersion: this.protocolVersion,
      extensionIds: this.extensionIds,
      extensionRevisions: Object.fromEntries(
        this.extensionIds.map((id) => [
          id,
          EXTENSION_SCHEMA_REVISIONS[id] ?? "unknown",
        ]),
      ),
      schemaDigest: this.schemaDigest,
      validated: observations.length,
      correlated,
      violations,
    };
  }
}

/**
 * A shallow copy whose `id` is a placeholder the schema can accept. See the
 * undeterminable-id case in `targetFor`.
 *
 * Substituting rather than DELETING is load-bearing. `JSONRPCError` requires
 * `id` through 2025-06-18 (it only became optional when the definition was
 * renamed `JSONRPCErrorResponse` at 2025-11-25), so dropping the member made
 * the exemption fail the very responses it exists to protect: a conforming
 * parse-error answer on a legacy run was reported as
 * `must have required property 'id'`. A placeholder satisfies both shapes —
 * `RequestId` is `["string","integer"]` on every revision — and leaves every
 * other member of the envelope graded.
 */
function withPlaceholderId(message: unknown): unknown {
  if (message === null || typeof message !== "object") return message;
  return { ...(message as Record<string, unknown>), id: 0 };
}

/**
 * A digest over the document's serialized JSON. Cheap, stable, and enough to
 * tell two vendored revisions apart in a stamp — the point is provenance, not
 * tamper resistance.
 */
function stableDigest(document: WireSchemaDocument): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(document)))).slice(0, 16);
}
