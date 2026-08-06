/**
 * Ajv-backed dialect-aware validator for Node runtimes (see
 * `dialect-dispatch-json-schema-validator.ts` for the dispatch rationale).
 *
 * Both engines mirror the upstream Node default configuration
 * (`strict: false`, `validateFormats: true`, `validateSchema: false`,
 * `allErrors: true`, with `ajv-formats` registered) and are created lazily.
 * Ajv compiles schemas via `new Function` — do not import this module from
 * browser/workerd entry points; use
 * `CspSafeDialectAwareJsonSchemaValidator` there instead.
 */

import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  DialectDispatchingJsonSchemaValidator,
  type DialectAwareJsonSchemaValidatorOptions,
} from "./dialect-dispatch-json-schema-validator.js";

export type { DialectAwareJsonSchemaValidatorOptions };

export class DialectAwareJsonSchemaValidator extends DialectDispatchingJsonSchemaValidator {
  constructor(options?: DialectAwareJsonSchemaValidatorOptions) {
    super(
      {
        draft2020: () => {
          const engine = new Ajv2020({
            strict: false,
            validateFormats: true,
            validateSchema: false,
            allErrors: true,
          });
          addFormats(engine);
          return new AjvJsonSchemaValidator(engine);
        },
        draft07: () => {
          const engine = new Ajv({
            strict: false,
            validateFormats: true,
            validateSchema: false,
            allErrors: true,
          });
          addFormats(engine);
          return new AjvJsonSchemaValidator(engine);
        },
      },
      options
    );
  }
}
