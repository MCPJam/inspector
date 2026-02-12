import Ajv from "ajv";
import type { ErrorObject } from "ajv";

const ajv = new Ajv();

export type UnstructuredValidationStatus = "not_applicable" | "schema_mismatch";

export interface ValidationReport {
  structuredErrors: ErrorObject[] | null | undefined;
  unstructuredStatus: UnstructuredValidationStatus;
}

export function validateToolOutput(
  result: any,
  outputSchema?: Record<string, unknown>,
): ValidationReport {
  const report: ValidationReport = {
    structuredErrors: undefined, // undefined means not checked
    unstructuredStatus: "not_applicable",
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
      report.structuredErrors = report.structuredErrors = [
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

  // The outputSchema applies to structuredContent only, not content.
  // The official SDK enforces this (error -32600), but third-party servers may not.
  if (!result.structuredContent && !result.isError) {
    report.unstructuredStatus = "schema_mismatch";
  }

  return report;
}
