/**
 * `mcpjam cloud feedback` — tell the MCPJam team about MCPJam itself: a bug,
 * a missing capability, something confusing.
 *
 * A thin binding over the `send_feedback` operation, so the CLI, the MCP tool
 * and the REST route validate the same input with the same messages. The text
 * goes to the MCPJam team, outside the caller's organization, and is kept for
 * 180 days; the help says so, because the person typing it should know before
 * they paste anything.
 */
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import {
  sendFeedbackOperation,
  type PlatformFeedbackReceipt,
  type SendFeedbackInput,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import {
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";

type FeedbackOptions = PlatformOptions & {
  kind: string;
  summary: string;
  details?: string;
  detailsFile?: string;
  operation?: string;
  requestId?: string;
  errorCode?: string;
  project?: string;
  idempotencyKey?: string;
};

/** `--details-file`: a path, or `-` for stdin. */
function readDetails(path: string): string {
  try {
    return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  } catch (error) {
    throw usageError(
      path === "-"
        ? "Failed to read --details from stdin."
        : `Failed to read --details from "${path}".`,
      { source: error instanceof Error ? error.message : String(error) }
    );
  }
}

function buildFeedbackInput(options: FeedbackOptions): SendFeedbackInput {
  if (options.details !== undefined && options.detailsFile !== undefined) {
    throw usageError("Pass --details or --details-file, not both.");
  }
  const details =
    options.detailsFile !== undefined
      ? readDetails(options.detailsFile)
      : options.details;
  // Validated by the operation's own schema, so a bad --kind or an over-long
  // --summary is a usage error here and never a request.
  const parsed = sendFeedbackOperation.inputSchema.safeParse({
    kind: options.kind,
    summary: options.summary,
    ...(details !== undefined ? { details } : {}),
    ...(options.operation !== undefined ? { operation: options.operation } : {}),
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    ...(options.errorCode !== undefined ? { errorCode: options.errorCode } : {}),
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.idempotencyKey !== undefined
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  });
  if (!parsed.success) {
    throw usageError(
      `Invalid input: ${parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message
        )
        .join("; ")}`
    );
  }
  return parsed.data;
}

function formatReceipt(receipt: PlatformFeedbackReceipt): string {
  return receipt.duplicate
    ? `Already received, thanks. An identical report is on file (${receipt.id}).`
    : `Sent to the MCPJam team (${receipt.id}). Thanks.`;
}

export function registerFeedbackCommand(cloud: Command): void {
  const command = cloud
    .command("feedback")
    .description(
      "Send feedback about MCPJam itself (a bug, a missing capability, something confusing) to the MCPJam team. Your text is sent to the MCPJam team, outside your organization, and stored for 180 days. Requires a signed-in account."
    )
    .requiredOption(
      "--kind <kind>",
      "bug, missing_capability, confusing, docs, or other"
    )
    .requiredOption(
      "--summary <text>",
      "One line: what went wrong or what is missing (up to 200 characters)."
    )
    .option(
      "--details <text>",
      "What you were trying to accomplish, what you expected, and what blocked you. For a missing capability, name the task and any workaround you tried. Up to 8000 characters. Never paste secrets, tokens, or raw tool output."
    )
    .option(
      "--details-file <path>",
      "Read --details from a file, or `-` for stdin."
    )
    .option(
      "--operation <name>",
      "The command, tool or app page in use (e.g. `cloud eval run`)."
    )
    .option(
      "--request-id <id>",
      "The request id from a failing command's error, so the report can be matched to the server's logs."
    )
    .option(
      "--error-code <code>",
      "The failing command's error code (e.g. INTERNAL_ERROR)."
    )
    .option(
      "--project <id-or-name>",
      "A project the report is about. Omit it otherwise: no project is assumed, not even a linked one."
    )
    .option(
      "--idempotency-key <key>",
      "Retry key: a retry with the same key returns the original receipt instead of filing the report twice."
    );

  bindOperation<FeedbackOptions, SendFeedbackInput, PlatformFeedbackReceipt>(
    command,
    sendFeedbackOperation,
    (options) => buildFeedbackInput(options),
    {
      // No project unless named: not the MCPJAM_PROJECT one, not the repo's
      // link. A report about the CLI filed against the linked project is
      // misfiled.
      ambientProject: false,
      cloudScope: { kind: "account" },
      formatHuman: formatReceipt,
    }
  );
}
