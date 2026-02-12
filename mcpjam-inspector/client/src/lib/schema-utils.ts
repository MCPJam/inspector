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

export type UnstructuredValidationStatus =
  | "not_applicable"
  | "valid"
  | "invalid_json"
  | "schema_mismatch";

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

  //  Validate raw content string (if it's a string)
  if (typeof result.content[0].text === "string") {
    try {
      const parsedContent = JSON.parse(result.content[0].text);
      const validate = ajv.compile(stripExtensionKeys(outputSchema));
      const isValid = validate(parsedContent);
      report.unstructuredStatus = isValid ? "valid" : "schema_mismatch";
    } catch (e) {
      // This will catch errors from JSON.parse if content is not valid JSON
      report.unstructuredStatus = "invalid_json";
    }
  }

  return report;
}
