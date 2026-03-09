import type { EvalResultInput } from "../eval-reporting-types.js";

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attrRegex = /([A-Za-z_:][\w:.-]*)="([^"]*)"/g;
  for (const match of raw.matchAll(attrRegex)) {
    const key = match[1];
    const value = match[2] ?? "";
    attributes[key] = value;
  }
  return attributes;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_");
}

export function parseJUnitXmlArtifact(xml: string): EvalResultInput[] {
  const results: EvalResultInput[] = [];
  const testcaseRegex =
    /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>|<testcase\b([^>]*)\/>/g;

  let index = 0;
  for (const match of xml.matchAll(testcaseRegex)) {
    const attributesRaw = match[1] ?? match[3] ?? "";
    const body = match[2] ?? "";
    const attributes = parseAttributes(attributesRaw);

    const className = attributes.classname ?? "";
    const name = attributes.name ?? `test-${index + 1}`;
    const caseTitle = className ? `${className}::${name}` : name;
    const timeSeconds = Number(attributes.time);
    const durationMs = Number.isFinite(timeSeconds)
      ? Math.max(0, Math.round(timeSeconds * 1000))
      : undefined;

    const hasFailure = /<failure\b/i.test(body);
    const hasError = /<error\b/i.test(body);
    const isSkipped = /<skipped\b/i.test(body);
    const passed = !hasFailure && !hasError && !isSkipped;

    let errorMessage: string | undefined;
    if (!passed) {
      const failureMatch = body.match(
        /<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/i
      );
      const skippedMatch = body.match(/<skipped\b[^>]*>([\s\S]*?)<\/skipped>/i);
      errorMessage = failureMatch?.[2]?.trim() || skippedMatch?.[1]?.trim();
      if (!errorMessage) {
        if (isSkipped) {
          errorMessage = "Test skipped";
        } else {
          errorMessage = "JUnit testcase failed";
        }
      }
    }

    results.push({
      caseTitle,
      query: caseTitle,
      passed,
      durationMs,
      externalIterationId: `${sanitizeId(caseTitle)}-${index + 1}`,
      error: errorMessage,
    });
    index += 1;
  }

  if (results.length === 0) {
    throw new Error("No <testcase> entries found in JUnit XML artifact");
  }

  return results;
}
