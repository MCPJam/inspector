import path from "node:path";
import {
  formatEvalRunDecisionSummary,
  renderStructuredRunHtml,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  type StructuredRunReport,
} from "@mcpjam/sdk";
import { writeFileAtomic } from "./atomic-write.js";
import { operationalError, usageError, writeResult } from "./output.js";
import { redactForTelemetry } from "./redaction.js";

export type ReporterFormat = "json-summary" | "junit-xml" | "html";

export function parseReporterFormat(
  value: string | undefined,
): ReporterFormat | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "json-summary" || value === "junit-xml" || value === "html") {
    return value;
  }

  throw usageError(
    `Invalid reporter "${value}". Use "json-summary", "junit-xml", or "html".`,
  );
}

export function writeReporterResult(
  reporter: ReporterFormat,
  report: StructuredRunReport,
): void {
  if (reporter === "junit-xml") {
    process.stdout.write(renderStructuredRunJUnitXml(report));
    return;
  }

  if (reporter === "html") {
    process.stdout.write(renderStructuredRunHtml(report));
    return;
  }

  writeResult(renderStructuredRunJson(report), "json");
}

/**
 * Human-only prose, kept separate so `--format json` remains one document.
 *
 * The SAME object the JSON reporter emits under `decisionSummary` and the HTML
 * reporter renders, run through the canonical renderer — so the three terminals
 * cannot disagree about the verdict, the unit its counts are in, the first
 * failed stage, the category or the next action.
 */
export function writeEvalDecisionSummary(
  format: string,
  summary: Parameters<typeof formatEvalRunDecisionSummary>[0] | undefined,
  destination: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  if (format !== "human" || !summary) return;
  destination.write(`${formatEvalRunDecisionSummary(summary)}\n`);
}

/**
 * `--out` and `--reporter` are two terminals for the same artifact, and only
 * the reporter half was redacted: `renderStructuredRunJson` scrubs the report,
 * while this wrote whatever it was handed straight to disk. So the identical
 * run exported clean through one flag and in the clear through the other.
 *
 * Redact here rather than at the two call sites, so a third `--out` cannot
 * reintroduce the gap by forgetting.
 */
export async function writeJsonArtifact(
  outputPath: string,
  payload: unknown,
): Promise<string> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);

  try {
    return await writeFileAtomic(
      resolvedPath,
      `${JSON.stringify(redactForTelemetry(payload), null, 2)}\n`,
      { createParents: true }
    );
  } catch (error) {
    throw operationalError(
      `Failed to write JSON artifact to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

export async function writeReporterArtifact(
  outputPath: string,
  reporter: ReporterFormat,
  report: StructuredRunReport
): Promise<string> {
  const resolvedPath = path.resolve(process.cwd(), outputPath);
  const body =
    reporter === "junit-xml"
      ? renderStructuredRunJUnitXml(report)
      : reporter === "html"
        ? renderStructuredRunHtml(report)
        : `${JSON.stringify(renderStructuredRunJson(report), null, 2)}\n`;

  try {
    return await writeFileAtomic(resolvedPath, body, { createParents: true });
  } catch (error) {
    throw operationalError(
      `Failed to write ${reporter} report to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      }
    );
  }
}
