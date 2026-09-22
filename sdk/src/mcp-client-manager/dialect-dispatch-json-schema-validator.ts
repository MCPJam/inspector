/**
 * Engine-agnostic core for dialect-aware JSON Schema validation.
 *
 * The upstream v2 defaults (`AjvJsonSchemaValidator` on Node,
 * `CfWorkerJsonSchemaValidator` on browser/workerd) reject any schema whose
 * `$schema` is not 2020-12, which hard-fails `tools/call` for every v1-SDK
 * server: `zod-to-json-schema` stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on emitted schemas.
 * The spec allows an explicitly declared draft-07 dialect on every protocol
 * version ("Tool with explicit draft-07 schema" is a published valid example;
 * 2020-12 is only the default when `$schema` is absent), so an inspector
 * must validate the declared dialect rather than reject it.
 *
 * Dispatch rule, per schema:
 * - no `$schema`, or a 2020-12 URI  -> the 2020-12 engine
 * - a draft-07 URI                  -> the draft-07 engine
 * - anything else                   -> no validation; warn, don't fail the call
 *
 * This module deliberately imports no validation engine: the Ajv-backed
 * subclass would drag `new Function`-based Ajv into browser/workerd bundles
 * (where it is CSP-hostile and breaks outright on Cloudflare Workers), so the
 * engines live in per-runtime subclasses.
 */

import type {
  JsonSchemaType,
  JsonSchemaValidator,
  jsonSchemaValidator,
} from "@modelcontextprotocol/client";

const DRAFT_2020_12_URIS = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft/2020-12/schema",
]);

const DRAFT_07_URIS = new Set([
  "https://json-schema.org/draft-07/schema",
  "http://json-schema.org/draft-07/schema",
]);

export interface DialectAwareJsonSchemaValidatorOptions {
  /**
   * Called when a schema declares a dialect that is neither 2020-12 nor
   * draft-07. That schema is not validated (the returned validator accepts
   * every input) so an exotic-but-legal dialect never blocks the tool call
   * itself. Defaults to a `console.warn`, emitted once per dialect per
   * instance — pass a handler to route the diagnostic elsewhere.
   */
  onUnknownDialect?: (declaredDialect: string) => void;
}

/** Lazy per-dialect engine factories supplied by a runtime-specific subclass. */
export interface DialectEngineFactories {
  draft2020: () => jsonSchemaValidator;
  draft07: () => jsonSchemaValidator;
}

/**
 * `jsonSchemaValidator` implementation that picks the engine from the
 * schema's declared `$schema`. Use one instance per `Client` via
 * `ClientOptions.jsonSchemaValidator` (engines may cache compiled schemas by
 * `$id`, so sharing an instance across servers could cross-pollinate `$id`
 * lookups).
 */
export class DialectDispatchingJsonSchemaValidator
  implements jsonSchemaValidator
{
  private draft2020Validator?: jsonSchemaValidator;
  private draft07Validator?: jsonSchemaValidator;
  private readonly engines: DialectEngineFactories;
  private readonly onUnknownDialect: (declaredDialect: string) => void;
  private readonly warnedDialects = new Set<string>();

  constructor(
    engines: DialectEngineFactories,
    options?: DialectAwareJsonSchemaValidatorOptions
  ) {
    this.engines = engines;
    this.onUnknownDialect =
      options?.onUnknownDialect ??
      ((declaredDialect) => {
        console.warn(
          `[mcpjam] Tool schema declares JSON Schema dialect "${declaredDialect}", ` +
            `which this validator does not support (2020-12 and draft-07 are). ` +
            `The schema was not validated; the tool call itself is unaffected.`
        );
      });
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const declared =
      typeof schema.$schema === "string"
        ? schema.$schema.replace(/#$/, "")
        : undefined;

    if (declared === undefined || DRAFT_2020_12_URIS.has(declared)) {
      this.draft2020Validator ??= this.engines.draft2020();
      return this.draft2020Validator.getValidator(schema);
    }
    if (DRAFT_07_URIS.has(declared)) {
      this.draft07Validator ??= this.engines.draft07();
      return this.draft07Validator.getValidator(schema);
    }

    const dialect = schema.$schema as string;
    if (!this.warnedDialects.has(dialect)) {
      this.warnedDialects.add(dialect);
      this.onUnknownDialect(dialect);
    }
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  }
}
