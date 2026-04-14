import { redactSensitiveValue } from "./redaction.js";
import type {
  StructuredCaseResult,
  StructuredRunReport,
} from "./structured-reporting.js";
import { summarizeStructuredCases } from "./structured-reporting.js";

export interface ToolCallEnvelopeValidationDetails {
  topLevelType: string;
  hasContent: boolean;
  contentItemTypes: string[];
  isError: boolean;
}

export interface ToolCallEnvelopeValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  details: ToolCallEnvelopeValidationDetails;
}

export interface ToolCallOutcomePolicy {
  failOnIsError?: boolean;
}

export interface ToolCallOutcomeEvaluationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  details: {
    isError: boolean;
    failOnIsError: boolean;
  };
}

export interface ToolCallValidationResult {
  passed: boolean;
  envelope?: ToolCallEnvelopeValidationResult;
  outcome?: ToolCallOutcomeEvaluationResult;
  errors: string[];
  warnings: string[];
  details: Partial<ToolCallEnvelopeValidationDetails> & {
    failOnIsError?: boolean;
  };
}

export function validateToolCallEnvelope(
  result: unknown
): ToolCallEnvelopeValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contentItemTypes: string[] = [];
  const details: ToolCallEnvelopeValidationDetails = {
    topLevelType: describeType(result),
    hasContent: false,
    contentItemTypes,
    isError: isRecord(result) && result.isError === true,
  };

  if (!isRecord(result)) {
    errors.push("Tool call result must be an object.");
    return { passed: false, errors, warnings, details };
  }

  validateIsErrorField(result, errors);

  if (result.content === undefined) {
    return { passed: errors.length === 0, errors, warnings, details };
  }

  details.hasContent = true;
  if (!Array.isArray(result.content)) {
    errors.push('Tool call result "content" must be an array when present.');
    return { passed: false, errors, warnings, details };
  }

  result.content.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push(`Content item ${index} must be an object.`);
      return;
    }

    if (typeof entry.type !== "string" || entry.type.length === 0) {
      errors.push(`Content item ${index} must include a string type.`);
      return;
    }

    contentItemTypes.push(entry.type);

    switch (entry.type) {
      case "text":
        if (typeof entry.text !== "string") {
          errors.push(
            `Text content item ${index} must include a string text field.`
          );
        }
        break;
      case "image":
        if (!isValidImageContent(entry)) {
          errors.push(
            `Image content item ${index} must include either data+mimeType or a url string.`
          );
        }
        break;
      case "resource":
        if (!isValidResourceContent(entry)) {
          errors.push(
            `Resource content item ${index} must include a resource object with a uri and payload fields.`
          );
        }
        break;
      default:
        warnings.push(
          `Unknown content item type "${entry.type}" at index ${index} was not strictly validated.`
        );
        break;
    }
  });

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    details,
  };
}

export function evaluateToolCallOutcome(
  result: unknown,
  policy: ToolCallOutcomePolicy = {}
): ToolCallOutcomeEvaluationResult {
  const failOnIsError = policy.failOnIsError ?? false;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (isRecord(result)) {
    validateIsErrorField(result, errors);
  }

  const isError = isRecord(result) && result.isError === true;

  if (failOnIsError && isError) {
    errors.push("Tool call result reported isError: true.");
  }

  return {
    passed: errors.length === 0,
    errors,
    warnings,
    details: {
      isError,
      failOnIsError,
    },
  };
}

export function validateToolCallResult(
  result: unknown,
  options: {
    envelope?: boolean;
    outcome?: ToolCallOutcomePolicy;
  } = {}
): ToolCallValidationResult {
  const envelope =
    options.envelope === false ? undefined : validateToolCallEnvelope(result);
  const outcome = options.outcome
    ? evaluateToolCallOutcome(result, options.outcome)
    : undefined;

  return {
    passed: (envelope?.passed ?? true) && (outcome?.passed ?? true),
    envelope,
    outcome,
    errors: [...(envelope?.errors ?? []), ...(outcome?.errors ?? [])],
    warnings: [...(envelope?.warnings ?? []), ...(outcome?.warnings ?? [])],
    details: {
      ...(envelope?.details ?? {}),
      ...(outcome ? { failOnIsError: outcome.details.failOnIsError } : {}),
    },
  };
}

export function buildToolCallValidationReport(
  result: ToolCallValidationResult,
  options: {
    durationMs?: number;
    rawResult?: unknown;
    metadata?: Record<string, unknown>;
  } = {}
): StructuredRunReport {
  const cases: StructuredCaseResult[] = [];

  if (result.envelope) {
    cases.push({
      id: "tool-call-envelope-valid",
      title: "tool-call-envelope-valid",
      category: "protocol",
      passed: result.envelope.passed,
      error:
        result.envelope.errors.length > 0
          ? result.envelope.errors.join(" ")
          : undefined,
      details: {
        warnings: result.envelope.warnings,
        ...result.envelope.details,
      },
    });
  }

  if (result.outcome) {
    cases.push({
      id: "tool-call-success-policy",
      title: "tool-call-success-policy",
      category: "validation",
      passed: result.outcome.passed,
      error:
        result.outcome.errors.length > 0
          ? result.outcome.errors.join(" ")
          : undefined,
      details: {
        warnings: result.outcome.warnings,
        ...result.outcome.details,
      },
    });
  }

  return {
    schemaVersion: 1,
    kind: "tools-call-validation",
    passed: result.passed,
    summary: summarizeStructuredCases(cases),
    cases,
    durationMs: options.durationMs ?? 0,
    metadata: {
      ...(options.metadata ?? {}),
      ...(options.rawResult === undefined
        ? {}
        : { redactedRawResult: redactSensitiveValue(options.rawResult) }),
    },
  };
}

function isValidImageContent(entry: Record<string, unknown>): boolean {
  if (typeof entry.url === "string" && entry.url.length > 0) {
    return true;
  }

  return (
    typeof entry.data === "string" &&
    entry.data.length > 0 &&
    typeof entry.mimeType === "string" &&
    entry.mimeType.length > 0
  );
}

function isValidResourceContent(entry: Record<string, unknown>): boolean {
  if (!isRecord(entry.resource)) {
    return false;
  }

  const resource = entry.resource;
  if (typeof resource.uri !== "string" || resource.uri.length === 0) {
    return false;
  }

  return (
    (typeof resource.text === "string" && resource.text.length > 0) ||
    (typeof resource.blob === "string" && resource.blob.length > 0)
  );
}

function validateIsErrorField(
  result: Record<string, unknown>,
  errors: string[]
): void {
  if (
    Object.prototype.hasOwnProperty.call(result, "isError") &&
    typeof result.isError !== "boolean"
  ) {
    errors.push('Tool call result "isError" must be a boolean when present.');
  }
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
