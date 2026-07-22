/**
 * CSP-safe dialect-aware validator for browser/workerd runtimes (see
 * `dialect-dispatch-json-schema-validator.ts` for the dispatch rationale).
 *
 * Built on `@cfworker/json-schema` (via the upstream `validators/cf-worker`
 * provider), which interprets schemas instead of compiling them with
 * `new Function` — Ajv is CSP-hostile in browsers and breaks outright on
 * Cloudflare Workers, which is why the upstream browser/workerd shims default
 * to this engine. Passing an explicit `draft` skips the provider's own
 * 2020-12-only `$schema` gate (the caller owns dialect choice), mirroring how
 * the Ajv flavor passes a pre-configured engine.
 */

import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import {
  DialectDispatchingJsonSchemaValidator,
  type DialectAwareJsonSchemaValidatorOptions,
} from "./dialect-dispatch-json-schema-validator.js";

export class CspSafeDialectAwareJsonSchemaValidator extends DialectDispatchingJsonSchemaValidator {
  constructor(options?: DialectAwareJsonSchemaValidatorOptions) {
    super(
      {
        draft2020: () => new CfWorkerJsonSchemaValidator({ draft: "2020-12" }),
        draft07: () => new CfWorkerJsonSchemaValidator({ draft: "7" }),
      },
      options
    );
  }
}
