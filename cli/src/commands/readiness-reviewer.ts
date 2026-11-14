/**
 * `mcpjam readiness reviewer …`: MCPJam signs in to a directory submission's
 * server as the directory's reviewer, with credentials the project keeps as
 * secrets. Each command takes secret NAMES only, and no flag takes a
 * credential's value: save it first with `mcpjam secrets create`.
 */
import type { Command } from "commander";
import {
  cancelReviewerAttemptOperation,
  createReviewerAttemptOperation,
  createReviewerHandoffOperation,
  getReviewerAttemptOperation,
  listReviewerAttemptsOperation,
  resumeReviewerAttemptOperation,
} from "@mcpjam/sdk/platform";
import { usageError } from "../lib/output.js";
import { addProjectOption, bindOperation, type PlatformOptions } from "../lib/platform-command.js";
import { parsePositiveInteger } from "../lib/server-config.js";

type Options = PlatformOptions & {
  project?: string;
  passwordSecret?: string;
  usernameSecret?: string;
  username?: string;
  loginUrl?: string;
  tenant?: string;
  idempotencyKey?: string;
  attempt?: string;
  limit?: number;
};

type Scope = { project?: string; submission: string };
const scoped = (options: Options, submission = ""): Scope => ({ project: options.project, submission });

/** Register `readiness reviewer start|status|resume|cancel` on the readiness group. */
export function registerReviewerAttemptCommands(readiness: Command): void {
  const reviewer = readiness
    .command("reviewer")
    .description("Rehearse a directory reviewer's sign-in to a submission's server");
  const verb = (name: string, description: string) =>
    addProjectOption(reviewer.command(name).description(description).argument("<submission>", "Submission id"));

  const start = verb("start", "Sign in as the reviewer with credentials saved as project secrets")
    .requiredOption("--password-secret <name>", "Name of the project secret holding the reviewer's password")
    .option("--username-secret <name>", "Name of the project secret holding the reviewer's username")
    .option("--username <text>", "The reviewer's username, when it is not a secret")
    .option("--login-url <url>", "The https sign-in page the reviewer starts on")
    .option("--tenant <name>", "The organization the reviewer must end up signed in to")
    .option("--idempotency-key <key>", "Replay guard: a retry returns the same attempt and run");
  // Checked here, as the MCP and agent surfaces check it: a value passed as a
  // secret's name is refused before anything is sent.
  bindOperation(start, createReviewerAttemptOperation, (options: Options, submission) => {
    const parsed = createReviewerAttemptOperation.inputSchema.safeParse({
      ...scoped(options, submission),
      passwordSecretName: options.passwordSecret,
      usernameSecretName: options.usernameSecret,
      username: options.username,
      loginUrl: options.loginUrl,
      tenant: options.tenant,
      idempotencyKey: options.idempotencyKey,
    });
    if (parsed.success) return parsed.data;
    throw usageError(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  });

  const status = verb("status", "List a submission's sign-in attempts, newest first, or show one")
    .option("--attempt <id>", "Show only this attempt, with its stages")
    .option("--limit <n>", "Attempts to list (1-50)", (value: string) => parsePositiveInteger(value, "Limit"));
  bindOperation<Options, Scope & { attempt?: string; limit?: number }>(
    status,
    {
      execute: ({ attempt, limit, ...scope }, context) =>
        attempt
          ? getReviewerAttemptOperation.execute({ ...scope, attempt }, context)
          : listReviewerAttemptsOperation.execute({ ...scope, limit }, context),
    },
    (options, submission) => ({ ...scoped(options, submission), attempt: options.attempt, limit: options.limit })
  );

  // Commander requires --attempt, so the fallback never applies.
  const resume = verb("resume", "Continue an attempt waiting for a person, in a new run").requiredOption(
    "--attempt <id>",
    "The attempt's id"
  );
  bindOperation(resume, resumeReviewerAttemptOperation, (options: Options, submission) => ({
    ...scoped(options, submission),
    attempt: options.attempt ?? "",
  }));

  const handoff = verb("handoff", "Create a single-use link to finish a paused reviewer sign-in")
    .requiredOption("--attempt <id>", "The attempt's id");
  bindOperation(handoff, createReviewerHandoffOperation, (options: Options, submission) => ({
    ...scoped(options, submission), attempt: options.attempt ?? "",
  }));

  const cancel = verb("cancel", "Stop an attempt that is running or waiting for a person").requiredOption(
    "--attempt <id>",
    "The attempt's id"
  );
  bindOperation(cancel, cancelReviewerAttemptOperation, (options: Options, submission) => ({
    ...scoped(options, submission),
    attempt: options.attempt ?? "",
  }));
}
