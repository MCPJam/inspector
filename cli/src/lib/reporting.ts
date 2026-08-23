import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  formatEvalDecisionSummary,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
  type StructuredRunReport,
} from "@mcpjam/sdk";
import { operationalError, usageError, writeResult } from "./output.js";
import { redactForTelemetry } from "./redaction.js";

export type ReporterFormat = "json-summary" | "junit-xml";

export function parseReporterFormat(
  value: string | undefined,
): ReporterFormat | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "json-summary" || value === "junit-xml") {
    return value;
  }

  throw usageError(
    `Invalid reporter "${value}". Use "json-summary" or "junit-xml".`,
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

  writeResult(renderStructuredRunJson(report), "json");
}

/** Human-only prose, kept separate so `--format json` remains one document. */
export function writeEvalDecisionSummary(
  format: string,
  summary: Parameters<typeof formatEvalDecisionSummary>[0] | undefined,
  destination: Pick<NodeJS.WriteStream, "write"> = process.stdout,
): void {
  if (format !== "human" || !summary) return;
  destination.write(`${formatEvalDecisionSummary(summary)}\n`);
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
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(
      resolvedPath,
      `${JSON.stringify(redactForTelemetry(payload), null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    throw operationalError(
      `Failed to write JSON artifact to "${resolvedPath}".`,
      {
        source: error instanceof Error ? error.message : String(error),
      },
    );
  }

  return resolvedPath;
}
