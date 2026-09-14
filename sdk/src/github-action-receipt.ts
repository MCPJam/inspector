import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";

export const MCPJAM_ACTION_RECEIPT_DIR = "MCPJAM_ACTION_RECEIPT_DIR";

/**
 * Hand an exact uploaded run back to the MCPJam GitHub Action.
 *
 * This is intentionally activated only by a private action environment variable.
 * It contains durable ids and display metadata, never credentials or test data.
 * A receipt failure is observational: the upload itself remains successful and
 * the action will report that it could not find its run instead of guessing one.
 */
export async function writeGithubActionReceipt(
  config: { baseUrl: string },
  input: Pick<ReportEvalResultsInput, "suiteName" | "framework">,
  report: ReportEvalResultsOutput
): Promise<void> {
  const directory = process.env[MCPJAM_ACTION_RECEIPT_DIR]?.trim();
  if (!directory) return;

  let baseUrl: string;
  try {
    const url = new URL(config.baseUrl);
    if (url.username || url.password) return;
    baseUrl = url.origin;
  } catch {
    return;
  }

  const receipt = {
    schemaVersion: 1,
    baseUrl,
    projectId: report.projectId,
    suiteId: report.suiteId,
    suiteName: input.suiteName,
    framework: input.framework,
    runId: report.runId,
  };
  try {
    await writeFile(
      join(directory, `${randomUUID()}.json`),
      `${JSON.stringify(receipt)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } catch {
    // Reporting succeeded. The action treats a missing receipt as incomplete.
  }
}
