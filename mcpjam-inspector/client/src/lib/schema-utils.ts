import Ajv from "ajv";
import type { ErrorObject } from "ajv";

const ajv = new Ajv();

/**
 * Recursively strips vendor extension keys (prefixed with "x-") from a JSON Schema.
 * These are custom annotations (e.g. "x-fastmcp-wrap-result") that are valid in JSON Schema
 * but cause AJV strict mode to reject the schema as unrecognized keywords.
 */
function stripExtensionKeys(schema: any): any {
  if (typeof schema !== "object" || schema === null) return schema;
  if (Array.isArray(schema)) return schema.map(stripExtensionKeys);
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-")) continue;
    cleaned[key] = stripExtensionKeys(value);
  }
  return cleaned;
}

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
      const validate = ajv.compile(stripExtensionKeys(outputSchema));
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
