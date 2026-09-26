/**
 * `mcpjam cloud studies` — publish a project environment for outside testers,
 * read what they did, and control who can reach it.
 *
 * ONE group for what used to be two. `cloud scenarios` published an environment
 * and took it down again, keyed by environment because the study does not exist
 * yet; `cloud user-testing` was everything keyed by the study. Splitting them
 * was an artifact of the old name, and both names survive as aliases so scripts
 * written against either keep running.
 *
 * BETA. Publishing is behind a per-organization flag; when it is off for yours
 * the server says so plainly. UNPUBLISHING is deliberately not gated — taking a
 * live study down has to keep working for an org that just lost the flag.
 */
import type { Command } from "commander";
import {
  cancelStudyInsightsOperation,
  dismissStudyFindingOperation,
  getStudyInsightsOperation,
  getStudyMetricsOperation,
  getStudySessionOperation,
  getStudySignalsOperation,
  getStudyUsageOperation,
  listStudyFindingsOperation,
  listStudySessionsOperation,
  rebindStudyOperation,
  removeStudyMemberOperation,
  requestStudyInsightsOperation,
  rotateStudyLinkOperation,
  setStudyGuestExecutionOperation,
  undismissStudyFindingOperation,
  getStudyOperation,
  listStudiesOperation,
  publishStudyOperation,
  unpublishStudyOperation,
  updateStudyOperation,
  upsertStudyMemberOperation,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { usageError } from "../lib/output.js";

type StudyOptions = PlatformOptions & {
  project?: string;
  study?: string;
  scenario?: string;
};

/**
 * Every command here addresses one study.
 *
 * `--scenario` is the deprecated spelling, kept so a script written against the
 * old `cloud user-testing` group keeps running. Neither flag is `required`,
 * because "exactly one of two" is not something Commander states; {@link studyOf}
 * enforces it and produces the usage error.
 */
function studyCommand(group: Command, name: string, description: string) {
  return addProjectOption(
    group
      .command(name)
      .description(description)
      .option("--study <id>", "Study ID")
      .option("--scenario <id>", "Deprecated alias for --study"),
  );
}

/**
 * Resolve the study selector, refusing both spellings at once.
 *
 * A precedence rule would be invisible: a half-migrated script passing both
 * keeps running against whichever of two possibly-different studies won, and
 * `rotate-link` and `remove-member` are in this group.
 */
function studyOf(options: StudyOptions): string {
  if (options.study !== undefined && options.scenario !== undefined) {
    throw usageError(
      "Use either --study or its deprecated --scenario alias, not both.",
    );
  }
  const selected = options.study ?? options.scenario;
  if (selected === undefined) {
    throw usageError("Missing required option: --study");
  }
  return selected;
}

function addPageOptions(command: Command): Command {
  return command
    .option("--cursor <cursor>", "Page cursor from a previous response")
    .option("--limit <n>", "Page size");
}

function pageArgs(options: { cursor?: string; limit?: string }) {
  const limit = parseIntegerOption(options.limit, "--limit");
  return {
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function registerStudiesCommands(program: Command): void {
  const group = program
    .command("studies")
    // The old spellings. `scenarios` was the publish/read group and
    // `user-testing` was everything keyed by the study; one group now, and both
    // names keep resolving so existing scripts do not break.
    .aliases(["scenarios", "user-testing"])
    .description(
      "Publish project environments as studies, read what testers did, and control who can reach them",
    );

  // ── Reads ───────────────────────────────────────────────────────────────

  bindOperation(
    studyCommand(
      group,
      "get",
      "One study's full read — model, system prompt, tool-approval policy, resolved servers, the environment it publishes — plus its actionable-insights envelope: findings aggregated over the latest analyzed window, with exemplar evidence. Only actionTarget mcp_server with actionability ready authorizes proposing a server change.",
    ),
    getStudyOperation,
    (options: StudyOptions) => ({
      project: options.project,
      study: studyOf(options),
    }),
  );

  bindOperation(
    addPageOptions(
      studyCommand(
        group,
        "sessions",
        "List the sessions real visitors had with a study: counts, feedback, device and segment, with a first-message preview. Summaries only — use `session` for a transcript.",
      ),
    ),
    listStudySessionsOperation,
    (options: StudyOptions & { cursor?: string; limit?: string }) => ({
      project: options.project,
      study: studyOf(options),
      ...pageArgs(options),
    }),
  );

  bindOperation(
    addPageOptions(
      studyCommand(
        group,
        "session",
        "Read one session's conversation, paged. These are real people talking to your product; prefer `metrics` or `findings` when you want the pattern rather than the words.",
      ).requiredOption("--session <id>", "Session ID"),
    ),
    getStudySessionOperation,
    (
      options: StudyOptions & {
        session: string;
        cursor?: string;
        limit?: string;
      },
    ) => ({
      project: options.project,
      study: studyOf(options),
      session: options.session,
      ...pageArgs(options),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "metrics",
      "Aggregate metrics across a study's sessions.",
    ).option("--population <name>", "Restrict to a session population"),
    getStudyMetricsOperation,
    (options: StudyOptions & { population?: string }) => ({
      project: options.project,
      study: studyOf(options),
      ...(options.population ? { population: options.population } : {}),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "usage",
      "Usage rates by visitor and device. Check `scan.truncated` before quoting any rate: true means it was computed over the most recent sessions, not all of them.",
    ),
    getStudyUsageOperation,
    (options: StudyOptions) => ({
      project: options.project,
      study: studyOf(options),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "findings",
      "Problems detected across a study's sessions, tracked over time.",
    ),
    listStudyFindingsOperation,
    (options: StudyOptions) => ({
      project: options.project,
      study: studyOf(options),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "signals",
      "The study's live analysis window, and the windowId its insights are keyed by.",
    ),
    getStudySignalsOperation,
    (options: StudyOptions) => ({
      project: options.project,
      study: studyOf(options),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "insights",
      "The model's analysis of one window, if one has been requested. Not-found means nobody asked, which is different from asked-and-working.",
    ).requiredOption("--window <id>", "Window ID (from `signals`)"),
    getStudyInsightsOperation,
    (options: StudyOptions & { window: string }) => ({
      project: options.project,
      study: studyOf(options),
      window: options.window,
    }),
  );

  // ── Insight lifecycle ───────────────────────────────────────────────────

  bindOperation(
    studyCommand(
      group,
      "request-insights",
      "Ask a model to analyze the current window. Returns pending; poll `insights`. Included with MCPJam — no credits are consumed; it counts against a daily insight quota shared with swarm insights. A 409 means the window has not been mined yet — wait rather than retrying in a loop.",
    ).option("--force", "Regenerate over a window that already has insights."),
    requestStudyInsightsOperation,
    (options: StudyOptions & { force?: boolean }) => ({
      project: options.project,
      study: studyOf(options),
      ...(options.force ? { force: true } : {}),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "cancel-insights",
      "Stop an in-flight generation. The recovery path for a window stuck pending — without it the only way forward is --force, which takes another slice of the daily insight quota.",
    ).requiredOption("--window <id>", "Window ID"),
    cancelStudyInsightsOperation,
    (options: StudyOptions & { window: string }) => ({
      project: options.project,
      study: studyOf(options),
      window: options.window,
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "dismiss-finding",
      "Mark a finding as not worth acting on. Its lifecycle keeps updating underneath.",
    ).requiredOption("--finding <id>", "Finding ID"),
    dismissStudyFindingOperation,
    (options: StudyOptions & { finding: string }) => ({
      project: options.project,
      study: studyOf(options),
      finding: options.finding,
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "undismiss-finding",
      "Bring a dismissed finding back into the active list.",
    ).requiredOption("--finding <id>", "Finding ID"),
    undismissStudyFindingOperation,
    (options: StudyOptions & { finding: string }) => ({
      project: options.project,
      study: studyOf(options),
      finding: options.finding,
    }),
  );

  // ── Exposure controls ───────────────────────────────────────────────────

  bindOperation(
    studyCommand(
      group,
      "update",
      "Rename a study, or change who may open its share link. --mode must be used ON ITS OWN: identity and exposure are separate operations upstream, and mixing them could leave the study live in a mode you did not ask for.",
    )
      .option("--name <name>")
      .option("--description <text>")
      .option(
        "--mode <mode>",
        "project_members | invited_only | anyone_with_link",
      ),
    updateStudyOperation,
    (
      options: StudyOptions & {
        name?: string;
        description?: string;
        mode?: "project_members" | "invited_only" | "anyone_with_link";
      },
    ) => ({
      project: options.project,
      study: studyOf(options),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "guest-execution",
      "Set what anonymous visitors may run on your account, and how much. A FULL REPLACEMENT: every flag is required, because these caps only mean something as a set and raising one while leaving a stale sibling produces a combination nobody chose.",
    )
      .requiredOption("--enabled <bool>", "true | false")
      .requiredOption("--computer-enabled <bool>", "true | false")
      .requiredOption("--shared-skills-enabled <bool>", "true | false")
      .requiredOption(
        "--daily-credit-cap <n>",
        "Hard ceiling on visitor spend per day, in credits",
      )
      .requiredOption("--daily-computer-start-cap <n>")
      .requiredOption("--max-concurrent-computers <n>")
      // The harness caps are OPTIONAL upstream (absent ⇒ harness disabled),
      // so they are optional here — but they are part of the same replacement,
      // and omitting them when the study has them set clears them. The help
      // text says so, because a silent reset of a limit someone chose is the
      // worst outcome this command can produce.
      .option(
        "--harness-enabled <bool>",
        "true | false. Omitting this REPLACES any existing harness setting with 'disabled'.",
      )
      .option("--daily-harness-spend-cap-micros <n>")
      .option("--daily-harness-call-cap <n>")
      .option("--max-concurrent-harness-runs <n>"),
    setStudyGuestExecutionOperation,
    (
      options: StudyOptions & {
        enabled: string;
        computerEnabled: string;
        sharedSkillsEnabled: string;
        dailyCreditCap: string;
        dailyComputerStartCap: string;
        maxConcurrentComputers: string;
        harnessEnabled?: string;
        dailyHarnessSpendCapMicros?: string;
        dailyHarnessCallCap?: string;
        maxConcurrentHarnessRuns?: string;
      },
    ) => {
      // Caps without `--harness-enabled` would send limits for a harness the
      // SAME request disables — the "combination nobody chose" this command's
      // own description warns about, and one the caller clearly did not mean,
      // since they took the trouble to name a cap.
      if (
        options.harnessEnabled === undefined &&
        (options.dailyHarnessSpendCapMicros !== undefined ||
          options.dailyHarnessCallCap !== undefined ||
          options.maxConcurrentHarnessRuns !== undefined)
      ) {
        throw usageError(
          "--harness-enabled is required when any harness cap is given: omitting it disables the harness, so the caps would land on nothing.",
        );
      }
      return {
        project: options.project,
        study: studyOf(options),
        enabled: parseBooleanFlag(options.enabled, "--enabled"),
        computerEnabled: parseBooleanFlag(
          options.computerEnabled,
          "--computer-enabled",
        ),
        sharedSkillsEnabled: parseBooleanFlag(
          options.sharedSkillsEnabled,
          "--shared-skills-enabled",
        ),
        dailyCreditCap: parseNumberFlag(
          options.dailyCreditCap,
          "--daily-credit-cap",
        ),
        dailyComputerStartCap: parseRequiredIntegerOption(
          options.dailyComputerStartCap,
          "--daily-computer-start-cap",
        ),
        maxConcurrentComputers: parseRequiredIntegerOption(
          options.maxConcurrentComputers,
          "--max-concurrent-computers",
        ),
        ...(options.harnessEnabled !== undefined
          ? {
              harnessEnabled: parseBooleanFlag(
                options.harnessEnabled,
                "--harness-enabled",
              ),
            }
          : {}),
        ...(options.dailyHarnessSpendCapMicros !== undefined
          ? {
              dailyHarnessSpendCapMicros: parseIntegerOption(
                options.dailyHarnessSpendCapMicros,
                "--daily-harness-spend-cap-micros",
              ),
            }
          : {}),
        ...(options.dailyHarnessCallCap !== undefined
          ? {
              dailyHarnessCallCap: parseIntegerOption(
                options.dailyHarnessCallCap,
                "--daily-harness-call-cap",
              ),
            }
          : {}),
        ...(options.maxConcurrentHarnessRuns !== undefined
          ? {
              maxConcurrentHarnessRuns: parseIntegerOption(
                options.maxConcurrentHarnessRuns,
                "--max-concurrent-harness-runs",
              ),
            }
          : {}),
      };
    },
  );

  bindOperation(
    studyCommand(
      group,
      "rotate-link",
      "Mint a new share link and invalidate the old one. IMMEDIATE AND IRREVERSIBLE: everyone holding the old URL loses access and every live session on it dies. This is what you do when a link has leaked.",
    ),
    rotateStudyLinkOperation,
    (options: StudyOptions) => ({
      project: options.project,
      study: studyOf(options),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "invite",
      "Grant one person access by email. Upsert, so re-inviting an existing member is not an error.",
    )
      .requiredOption("--email <email>")
      .option("--send-invite-email", "Also email them. Off by default."),
    upsertStudyMemberOperation,
    (
      options: StudyOptions & { email: string; sendInviteEmail?: boolean },
    ) => ({
      project: options.project,
      study: studyOf(options),
      email: options.email,
      ...(options.sendInviteEmail ? { sendInviteEmail: true } : {}),
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "remove-member",
      "Revoke one person's access.",
    ).requiredOption("--member <id-or-email>"),
    removeStudyMemberOperation,
    (options: StudyOptions & { member: string }) => ({
      project: options.project,
      study: studyOf(options),
      member: options.member,
    }),
  );

  bindOperation(
    studyCommand(
      group,
      "rebind",
      "Point a study at a different environment, KEEPING its link, members and session history. The alternative — unpublish and republish — mints a new link, which means re-sharing it with everyone.",
    ).requiredOption("--environment <id>", "Project environment ID"),
    rebindStudyOperation,
    (options: StudyOptions & { environment: string }) => ({
      project: options.project,
      study: studyOf(options),
      environmentId: options.environment,
    }),
  );
  // ── Publish / unpublish ─────────────────────────────────────────────────
  //
  // Keyed by ENVIRONMENT, not by study: the study does not exist yet. Both need
  // project admin; publishing is additionally beta-gated, unpublishing is not.

  bindOperation(
    addProjectOption(
      group
        .command("list")
        .description("List the studies published from a project"),
    ),
    listStudiesOperation,
    (options: PlatformOptions & { project?: string }) => ({
      project: options.project,
    }),
  );

  bindOperation(
    addProjectOption(
      group
        .command("publish")
        .description(
          "Publish an environment as a study and print its share link. Idempotent — re-publishing returns the existing study, with created: false. --name, --description and --mode apply at CREATE TIME, in the same call; on a re-publish they are ignored and the result says overridesIgnored: true (use `studies update` to change an existing study).",
        )
        .requiredOption("--environment <id>", "Project environment ID")
        .option("--name <name>", "Study name (create time only)")
        .option("--description <text>", "Study description (create time only)")
        .option(
          "--mode <mode>",
          "Who may open the share link (create time only): project_members | invited_only | anyone_with_link",
        ),
    ),
    publishStudyOperation,
    (
      options: PlatformOptions & {
        project?: string;
        environment: string;
        name?: string;
        description?: string;
        mode?: string;
      },
    ) => {
      // A misspelled mode is a usage error, answered here — not a server round
      // trip that spends a request to learn the flag was typed wrong.
      const mode = options.mode as (typeof STUDY_MODES)[number] | undefined;
      if (mode !== undefined && !STUDY_MODES.includes(mode)) {
        throw usageError(
          `option '--mode <mode>' must be one of ${STUDY_MODES.join(", ")}`,
        );
      }
      return {
        project: options.project,
        environment: options.environment,
        ...(options.name !== undefined ? { name: options.name } : {}),
        ...(options.description !== undefined
          ? { description: options.description }
          : {}),
        ...(mode !== undefined ? { mode } : {}),
      };
    },
  );

  bindOperation(
    addProjectOption(
      group
        .command("unpublish")
        .description(
          "Take an environment's study down, invalidating its share link and any live guest sessions. Idempotent.",
        )
        .requiredOption("--environment <id>", "Project environment ID"),
    ),
    unpublishStudyOperation,
    (options: PlatformOptions & { project?: string; environment: string }) => ({
      project: options.project,
      environment: options.environment,
    }),
  );
}

const STUDY_MODES = [
  "project_members",
  "invited_only",
  "anyone_with_link",
] as const;

/**
 * A boolean flag that takes a VALUE, not a presence flag.
 *
 * Presence flags cannot express "turn this off", and every field on
 * `guest-execution` is a full replacement — so `--enabled` with no way to say
 * `false` would make the command able to open guest execution and never able
 * to close it.
 */
function parseBooleanFlag(value: string, flag: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error(`${flag} must be true or false`);
}

function parseNumberFlag(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative number`);
  }
  return parsed;
}
