import type {
  ConformanceResult,
  OAuthConformanceSuiteResult,
  StepResult,
} from "./types.js";

const BODY_SNIPPET_LIMIT = 140;
const SENSITIVE_OAUTH_KEYS =
  "access_token|refresh_token|client_secret|id_token|code|code_verifier|accessToken|refreshToken|clientSecret|idToken|codeVerifier";

type BodySummary =
  | {
      kind: "html";
      pageTitle?: string;
      snippet?: string;
    }
  | {
      kind: "json" | "text";
      snippet?: string;
    };

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxLength = BODY_SNIPPET_LIMIT): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function redactSensitiveStrings(value: string): string {
  return value
    .replace(
      /(authorization\s*:\s*bearer\s+)([^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`([?&](?:${SENSITIVE_OAUTH_KEYS})=)([^&#\\s]+)`, "gi"),
      "$1[REDACTED]",
    )
    .replace(
      new RegExp(`("(?:${SENSITIVE_OAUTH_KEYS})"\\s*:\\s*")([^"]*)(")`, "gi"),
      '$1[REDACTED]$3',
    )
    .replace(
      new RegExp(`('(?:${SENSITIVE_OAUTH_KEYS})'\\s*:\\s*')([^']*)(')`, "gi"),
      "$1[REDACTED]$3",
    );
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function looksLikeHtml(
  body: unknown,
  contentType: string | undefined,
): body is string {
  if (typeof body !== "string") {
    return false;
  }

  if (contentType?.toLowerCase().includes("text/html")) {
    return true;
  }

  return /<!doctype html|<html[\s>]|<body[\s>]|<title[\s>]/i.test(body);
}

function summarizeObjectBody(body: Record<string, unknown>): string | undefined {
  const prioritizedKeys = [
    "error_description",
    "error",
    "message",
    "title",
    "detail",
    "description",
  ];

  for (const key of prioritizedKeys) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(`${key}: ${value}`);
    }
  }

  const serialized = JSON.stringify(body);
  return serialized === "{}" ? undefined : truncate(serialized);
}

function summarizeHtmlBody(body: string): BodySummary {
  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch
    ? collapseWhitespace(decodeHtmlEntities(titleMatch[1]))
    : undefined;

  const visibleText = collapseWhitespace(
    decodeHtmlEntities(
      body
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );

  let snippet = visibleText;
  if (pageTitle && snippet.startsWith(pageTitle)) {
    snippet = snippet.slice(pageTitle.length).trim();
  }

  return {
    kind: "html",
    ...(pageTitle ? { pageTitle } : {}),
    ...(snippet ? { snippet: truncate(snippet) } : {}),
  };
}

function summarizeBody(
  body: unknown,
  contentType: string | undefined,
): BodySummary | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (looksLikeHtml(body, contentType)) {
    return summarizeHtmlBody(body);
  }

  if (typeof body === "string") {
    const snippet = truncate(body);
    return snippet ? { kind: "text", snippet } : undefined;
  }

  if (typeof body === "object") {
    const snippet = summarizeObjectBody(body as Record<string, unknown>);
    return snippet ? { kind: "json", snippet } : undefined;
  }

  return { kind: "text", snippet: truncate(String(body)) };
}

function findFailureStep(result: ConformanceResult): StepResult | undefined {
  return result.steps.find((step) => step.status === "failed");
}

function deriveHint(
  step: StepResult,
  contentType: string | undefined,
  bodySummary: BodySummary | undefined,
): string | undefined {
  if (
    step.step === "received_authorization_code" &&
    (bodySummary?.kind === "html" || contentType?.toLowerCase().includes("text/html"))
  ) {
    return "Authorization endpoint returned an HTML login page instead of redirecting back to the callback URL.";
  }

  return undefined;
}

function extractEvidence(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }

  const evidence = (details as { evidence?: unknown }).evidence;
  if (typeof evidence !== "string" || !evidence.trim()) {
    return undefined;
  }

  return truncate(redactSensitiveStrings(evidence));
}

function countStatuses(result: ConformanceResult): string {
  const passed = result.steps.filter((step) => step.status === "passed").length;
  const failed = result.steps.filter((step) => step.status === "failed").length;
  const skipped = result.steps.filter((step) => step.status === "skipped").length;

  return [
    pluralize(passed, "passed step", "passed steps"),
    pluralize(failed, "failed step", "failed steps"),
    pluralize(skipped, "skipped step", "skipped steps"),
  ].join(", ");
}

function formatFailureLines(result: ConformanceResult): string[] {
  const failure = findFailureStep(result);
  if (!failure) {
    return [];
  }

  const http = failure.http ?? failure.httpAttempts[failure.httpAttempts.length - 1];
  const response = http?.response;
  const contentType = response?.headers?.["content-type"];
  const bodySummary = summarizeBody(response?.body, contentType);
  const hint = deriveHint(failure, contentType, bodySummary);
  const evidence = extractEvidence(failure.error?.details);

  const lines = [
    `Step: ${failure.step}`,
    `Title: ${failure.title}`,
    ...(failure.error?.message ? [`Error: ${failure.error.message}`] : []),
    ...(response
      ? [`HTTP: ${response.status} ${response.statusText}`]
      : []),
    ...(http?.request?.url ? [`URL: ${http.request.url}`] : []),
    ...(contentType ? [`Content-Type: ${contentType}`] : []),
  ];

  if (bodySummary?.kind === "html" && bodySummary.pageTitle) {
    lines.push(`Page title: ${bodySummary.pageTitle}`);
  }

  if (bodySummary?.snippet) {
    lines.push(`Snippet: ${bodySummary.snippet}`);
  }

  if (evidence) {
    lines.push(`Evidence: ${evidence}`);
  }

  if (hint) {
    lines.push(`Hint: ${hint}`);
  }

  return lines;
}

function formatVerification(result: ConformanceResult): string[] {
  if (!result.verification) {
    return [];
  }

  const lines: string[] = [];
  const { listTools, callTool } = result.verification;

  if (listTools) {
    const status = listTools.passed ? "PASS" : "FAIL";
    const count =
      listTools.toolCount === undefined
        ? ""
        : ` (${listTools.toolCount} tools)`;
    const errorSuffix = listTools.error ? ` — ${listTools.error}` : "";
    lines.push(`listTools: ${status}${count}${errorSuffix}`);
  }

  if (callTool) {
    const status = callTool.passed ? "PASS" : "FAIL";
    const errorSuffix = callTool.error ? ` — ${callTool.error}` : "";
    lines.push(`callTool(${callTool.toolName}): ${status}${errorSuffix}`);
  }

  return lines;
}

export function formatOAuthConformanceHuman(
  result: ConformanceResult,
): string {
  const lines = [
    `OAuth conformance: ${result.passed ? "PASSED" : "FAILED"}`,
    `Server: ${result.serverUrl}`,
    `Flow: ${result.protocolVersion} / ${result.registrationStrategy}`,
    `Summary: ${result.summary}`,
    `Duration: ${result.durationMs}ms`,
    `Steps: ${countStatuses(result)}`,
  ];

  const failureLines = formatFailureLines(result);
  if (failureLines.length > 0) {
    lines.push("", "Failure", ...failureLines);
  }

  const verificationLines = formatVerification(result);
  if (verificationLines.length > 0) {
    lines.push("", "Verification", ...verificationLines);
  }

  return lines.join("\n");
}

export function formatOAuthConformanceSuiteHuman(
  result: OAuthConformanceSuiteResult,
): string {
  const lines = [
    `OAuth conformance suite: ${result.passed ? "PASSED" : "FAILED"}`,
    `Suite: ${result.name}`,
    `Server: ${result.serverUrl}`,
    `Summary: ${result.summary}`,
    `Duration: ${result.durationMs}ms`,
    "",
    "Flows",
    ...result.results.map((flow) => `${flow.passed ? "PASS" : "FAIL"} ${flow.label}`),
  ];

  const failures = result.results.filter((flow) => !flow.passed);
  if (failures.length > 0) {
    lines.push("", "Failure details");
    for (const failure of failures) {
      const stepLines = formatFailureLines(failure);
      const verificationLines = formatVerification(failure);
      const detailLines =
        stepLines.length > 0 && verificationLines.length > 0
          ? [...stepLines, "", "Verification", ...verificationLines]
          : stepLines.length > 0
            ? stepLines
            : verificationLines.length > 0
              ? ["Verification", ...verificationLines]
              : [`Summary: ${failure.summary}`];
      lines.push("", `[${failure.label}]`, ...detailLines);
    }
  }

  return lines.join("\n");
}
