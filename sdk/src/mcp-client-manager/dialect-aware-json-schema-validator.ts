/**
 * Dialect-aware JSON Schema validator for tool input/output schemas.
 *
 * The upstream v2 default (`AjvJsonSchemaValidator` with no engine) rejects
 * any schema whose `$schema` is not 2020-12, which hard-fails `tools/call`
 * for every v1-SDK server: `zod-to-json-schema` stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on emitted schemas.
 * The spec allows an explicitly declared draft-07 dialect on every protocol
 * version ("Tool with explicit draft-07 schema" is a published valid example;
 * 2020-12 is only the default when `$schema` is absent), so an inspector
 * must validate the declared dialect rather than reject it.
 *
 * Dispatch rule, per schema:
 * - no `$schema`, or a 2020-12 URI  -> Ajv 2020-12 engine
 * - a draft-07 URI                  -> Ajv draft-07 engine
 * - anything else                   -> no validation (report, don't fail the call)
 *
 * Both engines mirror the upstream default configuration
 * (`strict: false`, `validateFormats: true`, `validateSchema: false`,
 * `allErrors: true`, with `ajv-formats` registered) and are created lazily.
 */

import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
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
   * Called once per `getValidator` when a schema declares a dialect that is
   * neither 2020-12 nor draft-07. That schema is not validated (the returned
   * validator accepts every input) so an exotic-but-legal dialect never
   * blocks the tool call itself.
   */
  onUnknownDialect?: (declaredDialect: string) => void;
}

/**
 * `jsonSchemaValidator` implementation that picks the Ajv engine from the
 * schema's declared `$schema`. Pass one instance per `Client` via
 * `ClientOptions.jsonSchemaValidator` (Ajv caches compiled schemas by `$id`,
 * so sharing an instance across servers could cross-pollinate `$id` lookups).
 */
export class DialectAwareJsonSchemaValidator implements jsonSchemaValidator {
  private draft2020Validator?: AjvJsonSchemaValidator;
  private draft07Validator?: AjvJsonSchemaValidator;
  private readonly onUnknownDialect?: (declaredDialect: string) => void;

  constructor(options?: DialectAwareJsonSchemaValidatorOptions) {
    this.onUnknownDialect = options?.onUnknownDialect;
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const declared =
      typeof schema.$schema === "string"
        ? schema.$schema.replace(/#$/, "")
        : undefined;

    if (declared === undefined || DRAFT_2020_12_URIS.has(declared)) {
      return this.getDraft2020Validator().getValidator(schema);
    }
    if (DRAFT_07_URIS.has(declared)) {
      return this.getDraft07Validator().getValidator(schema);
    }

    this.onUnknownDialect?.(schema.$schema as string);
    return (input: unknown) => ({
      valid: true,
      data: input as T,
      errorMessage: undefined,
    });
  }

  private getDraft2020Validator(): AjvJsonSchemaValidator {
    if (!this.draft2020Validator) {
      const engine = new Ajv2020({
        strict: false,
        validateFormats: true,
        validateSchema: false,
        allErrors: true,
      });
      addFormats(engine);
      this.draft2020Validator = new AjvJsonSchemaValidator(engine);
    }
    return this.draft2020Validator;
  }

  private getDraft07Validator(): AjvJsonSchemaValidator {
    if (!this.draft07Validator) {
      const engine = new Ajv({
        strict: false,
        validateFormats: true,
        validateSchema: false,
        allErrors: true,
      });
      addFormats(engine);
      this.draft07Validator = new AjvJsonSchemaValidator(engine);
    }
    return this.draft07Validator;
  }
}
