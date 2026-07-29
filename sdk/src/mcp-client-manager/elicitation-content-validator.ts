/**
 * The strict elicitation-content validator, as a shared factory.
 *
 * One rule, two consumers: the manager's standalone MRTR path and any task
 * `input_required` driver must judge accepted elicitation content against the
 * request's `requestedSchema` with the SAME strictness, or a response the
 * interactive path would refuse sails through the task path. The closure was
 * previously a private member of `MCPClientManager`; it lives here so a
 * surface wiring `TaskInputDriverOptions.validateElicitationContent` (the CLI)
 * uses the identical authority instead of a hand-rolled copy free to drift.
 *
 * Unlike tool-output validation, an unknown JSON-Schema dialect is treated as
 * INVALID (not fail-open): elicitation content is untrusted, so an exotic
 * dialect must not wave it through. The dialect-aware validator is constructed
 * per call so the throwing `onUnknownDialect` never leaks state between
 * validations.
 *
 * Node-only: `DialectAwareJsonSchemaValidator` compiles via `new Function`.
 * Browser/workerd surfaces build their own from
 * `CspSafeDialectAwareJsonSchemaValidator`.
 */

import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { DialectAwareJsonSchemaValidator } from "./dialect-aware-json-schema-validator.js";
import type { ElicitationContentValidator } from "./mrtr-driver.js";

export function createStrictElicitationContentValidator(): ElicitationContentValidator {
  return (requestedSchema, content) => {
    if (typeof requestedSchema !== "object" || requestedSchema === null) {
      return { valid: false, error: "requestedSchema is not an object" };
    }
    const strict = new DialectAwareJsonSchemaValidator({
      onUnknownDialect: (dialect) => {
        throw new Error(
          `Elicitation content declares unsupported JSON Schema dialect "${dialect}".`
        );
      },
    });
    let validate;
    try {
      validate = strict.getValidator(requestedSchema as JsonSchemaType);
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const result = validate(content);
    return { valid: result.valid, error: result.errorMessage };
  };
}
