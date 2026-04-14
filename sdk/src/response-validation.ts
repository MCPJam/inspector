import {
  CallToolResultSchema,
  ContentBlockSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveValue } from "./redaction.js";
import type {
  StructuredCaseResult,
  StructuredRunReport,
} from "./structured-reporting.js";
import { summarizeStructuredCases } from "./structured-reporting.js";

const MAX_TEXT_PREVIEW_CHARS = 160;
const MAX_REPORTED_CONTENT_ITEMS = 10;

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

  if (result.content !== undefined) {
    details.hasContent = true;
    if (!Array.isArray(result.content)) {
      errors.push('Tool call result "content" must be an array when present.');
      return { passed: false, errors, warnings, details };
    }

    result.content.forEach((entry) => {
      if (isRecord(entry) && typeof entry.type === "string" && entry.type.length > 0) {
        contentItemTypes.push(entry.type);
      }
    });
  }

  const parsedResult = CallToolResultSchema.safeParse(result);
  if (!parsedResult.success) {
    errors.push(...parsedResult.error.issues.map(formatValidationIssue));
  }

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
    const parsedResult = CallToolResultSchema.safeParse(result);
    if (!parsedResult.success) {
      const isErrorIssues = parsedResult.error.issues
        .filter((issue) => issue.path[0] === "isError")
        .map(formatValidationIssue);
      errors.push(...isErrorIssues);
    }
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
        : {
            redactedRawResult: redactSensitiveValue(
              summarizeToolCallResultForReport(options.rawResult)
            ),
          }),
    },
  };
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

function formatValidationIssue(issue: {
  path: PropertyKey[];
  message: string;
}): string {
  if (issue.path.length === 0) {
    return `Tool call result failed MCP validation: ${issue.message}`;
  }

  const path = issue.path
    .map((segment) =>
      typeof segment === "number"
        ? `[${segment}]`
        : typeof segment === "string"
          ? segment
          : String(segment)
    )
    .join(".");
  const normalizedPath = path.replace(/\.\[/g, "[");

  return `Tool call result failed MCP validation at "${normalizedPath}": ${issue.message}`;
}

function summarizeToolCallResultForReport(result: unknown): unknown {
  if (!isRecord(result)) {
    return compactUnknownValue(result);
  }

  const summary: Record<string, unknown> = {};

  if (typeof result.isError === "boolean") {
    summary.isError = result.isError;
  }

  if (Array.isArray(result.content)) {
    summary.contentCount = result.content.length;
    summary.content = result.content
      .slice(0, MAX_REPORTED_CONTENT_ITEMS)
      .map((entry) => summarizeContentBlockForReport(entry));

    if (result.content.length > MAX_REPORTED_CONTENT_ITEMS) {
      summary.truncatedContentItems =
        result.content.length - MAX_REPORTED_CONTENT_ITEMS;
    }
  }

  if (isRecord(result.structuredContent)) {
    summary.structuredContentKeys = Object.keys(result.structuredContent).sort();
  }

  if (isRecord(result._meta)) {
    summary.metaKeys = Object.keys(result._meta).sort();
  }

  return summary;
}

function summarizeContentBlockForReport(value: unknown): unknown {
  if (!isRecord(value) || typeof value.type !== "string") {
    return compactUnknownValue(value);
  }

  const parsedBlock = ContentBlockSchema.safeParse(value);
  if (!parsedBlock.success) {
    return {
      type: value.type,
      invalid: true,
      issues: parsedBlock.error.issues.map((issue) => issue.message),
    };
  }

  const content = parsedBlock.data;
  switch (content.type) {
    case "text":
      return {
        type: content.type,
        textLength: content.text.length,
        textPreview: truncateText(content.text),
      };
    case "image":
    case "audio":
      return {
        type: content.type,
        mimeType: content.mimeType,
        dataLength: content.data.length,
      };
    case "resource":
      return {
        type: content.type,
        resource: summarizeEmbeddedResourceForReport(content.resource),
      };
    case "resource_link":
      return {
        type: content.type,
        uri: content.uri,
        name: content.name,
        ...(content.title === undefined ? {} : { title: content.title }),
        ...(content.mimeType === undefined
          ? {}
          : { mimeType: content.mimeType }),
        ...(content.description === undefined
          ? {}
          : {
              descriptionLength: content.description.length,
              descriptionPreview: truncateText(content.description),
            }),
      };
  }
}

function summarizeEmbeddedResourceForReport(
  resource: Record<string, unknown>
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    uri: resource.uri,
  };

  if (typeof resource.mimeType === "string") {
    summary.mimeType = resource.mimeType;
  }

  if (typeof resource.text === "string") {
    summary.textLength = resource.text.length;
    summary.textPreview = truncateText(resource.text);
  }

  if (typeof resource.blob === "string") {
    summary.blobLength = resource.blob.length;
  }

  return summary;
}

function compactUnknownValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateText(value);
  }

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
    };
  }

  if (isRecord(value)) {
    return {
      kind: "object",
      keys: Object.keys(value).sort(),
    };
  }

  return value;
}

function truncateText(value: string): string {
  return value.length <= MAX_TEXT_PREVIEW_CHARS
    ? value
    : `${value.slice(0, MAX_TEXT_PREVIEW_CHARS)}…`;
}
