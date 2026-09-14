import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";

export const MCPJAM_ACTION_RECEIPT_DIR = "MCPJAM_ACTION_RECEIPT_DIR";

/**
 * SYNC: `DEFAULT_MCPJAM_PROJECT` in `./report-eval-results.ts`, inlined to keep
 * this leaf module out of an import cycle with its two callers.
 */
const DEFAULT_PROJECT_SENTINEL = "default";

/** The action's own receipt check, so a receipt it would drop is never written. */
const CONCRETE_ID = /^[a-zA-Z0-9_-]+$/;

/**
 * The project the run was reported under, or nothing.
 *
 * `report.projectId` is optional by contract — a backend that does not echo it
 * yet is supported — so the configured project stands in for it. The zero-config
 * `"default"` sentinel never does: it is not an id, and a receipt carrying it
 * would send the action looking for a project that does not exist.
 */
function resolveReceiptProjectId(
  reported: string | undefined,
  configured: string | undefined
): string | undefined {
  for (const candidate of [reported, configured]) {
    const trimmed = candidate?.trim();
    if (
      trimmed &&
      trimmed !== DEFAULT_PROJECT_SENTINEL &&
      CONCRETE_ID.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return undefined;
}

/**
 * Hand an exact uploaded run back to the MCPJam GitHub Action.
 *
 * This is intentionally activated only by a private action environment variable.
 * It contains durable ids and display metadata, never credentials or test data.
 * A receipt failure is observational: the upload itself remains successful and
 * the action will report that it could not find its run instead of guessing one.
 */
export async function writeGithubActionReceipt(
  config: { baseUrl: string; project?: string },
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

  const projectId = resolveReceiptProjectId(report.projectId, config.project);
  if (!projectId) return;

  const receipt = {
    schemaVersion: 1,
    baseUrl,
    projectId,
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
