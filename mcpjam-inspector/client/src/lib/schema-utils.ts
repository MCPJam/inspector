import Ajv from "ajv";
import type { ErrorObject } from "ajv";

const ajv = new Ajv({ strict: false });

export interface ValidationReport {
  structuredErrors: ErrorObject[] | null | undefined;
}

export function validateToolOutput(
  result: any,
  outputSchema?: Record<string, unknown>,
): ValidationReport {
  const report: ValidationReport = {
    structuredErrors: undefined, // undefined means not checked
  };

  if (!outputSchema) {
    return report;
  }

  if (result.structuredContent) {
    try {
      const validate = ajv.compile(outputSchema);
      const isValid = validate(result.structuredContent);
      report.structuredErrors = isValid ? null : validate.errors || []; // null means valid
    } catch (e) {
      // When the output schema is itself invalid
      report.structuredErrors = [
        {
          keyword: "schema-compilation",
          instancePath: "",
          schemaPath: "",
          params: {},
          message:
            "The provided outputSchema is invalid and could not be compiled.",
        } as any,
      ];
    }
  }

  return report;
}
