/**
 * `mcpjam cloud user-testing` — what a published scenario produced, and who may
 * reach it.
 *
 * `mcpjam cloud scenarios` publishes an environment and takes it down again, keyed by
 * environment because the scenario does not exist yet. This group is keyed by
 * the SCENARIO and covers everything after that: reading the sessions real
 * visitors had, the metrics and findings over them, and the controls that
 * decide who can open the link at all.
 *
 * TWO KINDS OF COMMAND live here, and the difference is worth knowing before
 * you script any of it:
 *
 *   READS — sessions, metrics, usage, findings, insights. Safe to poll.
 *   EXPOSURE CONTROLS — mode, guest execution, link rotation, members,
 *     rebinding. These decide who can talk to your servers and how much they
 *     may spend doing it. `rotate-link` in particular is immediate and
 *     irreversible: everyone holding the old URL loses access.
 *
 * AUTHORIZATION differs from the rest of the CLI. These gate on the WORKSPACE
 * role rather than the project role, and workspace membership is enough for
 * most of them — mode changes, member edits and link rotation included. Only
 * guest execution and rebinding need project ADMIN, and a legacy workspace
 * with no organization denies `sk_` keys outright. The server's message says
 * which; this CLI does not pre-guess.
 */
import type { Command } from "commander";
import {
  cancelUserTestingInsightsOperation,
  dismissUserTestingFindingOperation,
  getUserTestingInsightsOperation,
  getUserTestingMetricsOperation,
  getUserTestingSessionOperation,
  getUserTestingSignalsOperation,
  getUserTestingUsageOperation,
  listUserTestingFindingsOperation,
  listUserTestingSessionsOperation,
  rebindUserTestingScenarioOperation,
  removeUserTestingMemberOperation,
  requestUserTestingInsightsOperation,
  rotateUserTestingLinkOperation,
  setUserTestingGuestExecutionOperation,
  undismissUserTestingFindingOperation,
  getUserTestingScenarioOperation,
  updateUserTestingScenarioOperation,
  upsertUserTestingMemberOperation,
} from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  parseIntegerOption,
  parseRequiredIntegerOption,
  type PlatformOptions,
} from "../lib/platform-command.js";
import { usageError } from "../lib/output.js";

type ScenarioOptions = PlatformOptions & {
  project?: string;
  scenario: string;
};

/** Every command here addresses one scenario. */
function scenarioCommand(group: Command, name: string, description: string) {
  return addProjectOption(
    group
      .command(name)
      .description(description)
      .requiredOption("--scenario <id>", "Scenario ID"),
  );
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

export function registerUserTestingCommands(program: Command): void {
  const group = program
    .command("user-testing")
    .description(
      "Read what a published scenario produced, and control who can reach it",
    );

  // ── Reads ───────────────────────────────────────────────────────────────

  bindOperation(
    scenarioCommand(
      group,
      "get",
      "Scenario detail plus its actionable-insights envelope: findings aggregated over the latest analyzed window, with exemplar evidence. Only actionTarget mcp_server with actionability ready authorizes proposing a server change.",
    ),
    getUserTestingScenarioOperation,
    (options: ScenarioOptions) => ({
      project: options.project,
      scenario: options.scenario,
    }),
  );

  bindOperation(
    addPageOptions(
      scenarioCommand(
        group,
        "sessions",
        "List the sessions real visitors had with a scenario: counts, feedback, device and segment, with a first-message preview. Summaries only — use `session` for a transcript.",
      ),
    ),
    listUserTestingSessionsOperation,
    (options: ScenarioOptions & { cursor?: string; limit?: string }) => ({
      project: options.project,
      scenario: options.scenario,
      ...pageArgs(options),
    }),
  );

  bindOperation(
    addPageOptions(
      scenarioCommand(
        group,
        "session",
        "Read one session's conversation, paged. These are real people talking to your product; prefer `metrics` or `findings` when you want the pattern rather than the words.",
      ).requiredOption("--session <id>", "Session ID"),
    ),
    getUserTestingSessionOperation,
    (
      options: ScenarioOptions & {
        session: string;
        cursor?: string;
        limit?: string;
      },
    ) => ({
      project: options.project,
      scenario: options.scenario,
      session: options.session,
      ...pageArgs(options),
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "metrics",
      "Aggregate metrics across a scenario's sessions.",
    ).option("--population <name>", "Restrict to a session population"),
    getUserTestingMetricsOperation,
    (options: ScenarioOptions & { population?: string }) => ({
      project: options.project,
      scenario: options.scenario,
      ...(options.population ? { population: options.population } : {}),
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "usage",
      "Usage rates by visitor and device. Check `scan.truncated` before quoting any rate: true means it was computed over the most recent sessions, not all of them.",
    ),
    getUserTestingUsageOperation,
    (options: ScenarioOptions) => ({
      project: options.project,
      scenario: options.scenario,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "findings",
      "Problems detected across a scenario's sessions, tracked over time.",
    ),
    listUserTestingFindingsOperation,
    (options: ScenarioOptions) => ({
      project: options.project,
      scenario: options.scenario,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "signals",
      "The scenario's live analysis window, and the windowId its insights are keyed by.",
    ),
    getUserTestingSignalsOperation,
    (options: ScenarioOptions) => ({
      project: options.project,
      scenario: options.scenario,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "insights",
      "The model's analysis of one window, if one has been requested. Not-found means nobody asked, which is different from asked-and-working.",
    ).requiredOption("--window <id>", "Window ID (from `signals`)"),
    getUserTestingInsightsOperation,
    (options: ScenarioOptions & { window: string }) => ({
      project: options.project,
      scenario: options.scenario,
      window: options.window,
    }),
  );

  // ── Insight lifecycle ───────────────────────────────────────────────────

  bindOperation(
    scenarioCommand(
      group,
      "request-insights",
      "Ask a model to analyze the current window. Returns pending; poll `insights`. SPENDS against a daily budget shared with swarm insights. A 409 means the window has not been mined yet — wait rather than retrying in a loop.",
    ).option("--force", "Regenerate over a window that already has insights."),
    requestUserTestingInsightsOperation,
    (options: ScenarioOptions & { force?: boolean }) => ({
      project: options.project,
      scenario: options.scenario,
      ...(options.force ? { force: true } : {}),
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "cancel-insights",
      "Stop an in-flight generation. The recovery path for a window stuck pending — without it the only way forward is --force, which spends again.",
    ).requiredOption("--window <id>", "Window ID"),
    cancelUserTestingInsightsOperation,
    (options: ScenarioOptions & { window: string }) => ({
      project: options.project,
      scenario: options.scenario,
      window: options.window,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "dismiss-finding",
      "Mark a finding as not worth acting on. Its lifecycle keeps updating underneath.",
    ).requiredOption("--finding <id>", "Finding ID"),
    dismissUserTestingFindingOperation,
    (options: ScenarioOptions & { finding: string }) => ({
      project: options.project,
      scenario: options.scenario,
      finding: options.finding,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "undismiss-finding",
      "Bring a dismissed finding back into the active list.",
    ).requiredOption("--finding <id>", "Finding ID"),
    undismissUserTestingFindingOperation,
    (options: ScenarioOptions & { finding: string }) => ({
      project: options.project,
      scenario: options.scenario,
      finding: options.finding,
    }),
  );

  // ── Exposure controls ───────────────────────────────────────────────────

  bindOperation(
    scenarioCommand(
      group,
      "update",
      "Rename a scenario, or change who may open its share link. --mode must be used ON ITS OWN: identity and exposure are separate operations upstream, and mixing them could leave the scenario live in a mode you did not ask for.",
    )
      .option("--name <name>")
      .option("--description <text>")
      .option(
        "--mode <mode>",
        "project_members | invited_only | anyone_with_link",
      ),
    updateUserTestingScenarioOperation,
    (
      options: ScenarioOptions & {
        name?: string;
        description?: string;
        mode?: "project_members" | "invited_only" | "anyone_with_link";
      },
    ) => ({
      project: options.project,
      scenario: options.scenario,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.description !== undefined
        ? { description: options.description }
        : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    }),
  );

  bindOperation(
    scenarioCommand(
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
      // and omitting them when the scenario has them set clears them. The help
      // text says so, because a silent reset of a limit someone chose is the
      // worst outcome this command can produce.
      .option(
        "--harness-enabled <bool>",
        "true | false. Omitting this REPLACES any existing harness setting with 'disabled'.",
      )
      .option("--daily-harness-spend-cap-micros <n>")
      .option("--daily-harness-call-cap <n>")
      .option("--max-concurrent-harness-runs <n>"),
    setUserTestingGuestExecutionOperation,
    (
      options: ScenarioOptions & {
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
        scenario: options.scenario,
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
    scenarioCommand(
      group,
      "rotate-link",
      "Mint a new share link and invalidate the old one. IMMEDIATE AND IRREVERSIBLE: everyone holding the old URL loses access and every live session on it dies. This is what you do when a link has leaked.",
    ),
    rotateUserTestingLinkOperation,
    (options: ScenarioOptions) => ({
      project: options.project,
      scenario: options.scenario,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "invite",
      "Grant one person access by email. Upsert, so re-inviting an existing member is not an error.",
    )
      .requiredOption("--email <email>")
      .option("--send-invite-email", "Also email them. Off by default."),
    upsertUserTestingMemberOperation,
    (
      options: ScenarioOptions & { email: string; sendInviteEmail?: boolean },
    ) => ({
      project: options.project,
      scenario: options.scenario,
      email: options.email,
      ...(options.sendInviteEmail ? { sendInviteEmail: true } : {}),
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "remove-member",
      "Revoke one person's access.",
    ).requiredOption("--member <id-or-email>"),
    removeUserTestingMemberOperation,
    (options: ScenarioOptions & { member: string }) => ({
      project: options.project,
      scenario: options.scenario,
      member: options.member,
    }),
  );

  bindOperation(
    scenarioCommand(
      group,
      "rebind",
      "Point a scenario at a different environment, KEEPING its link, members and session history. The alternative — unpublish and republish — mints a new link, which means re-sharing it with everyone.",
    ).requiredOption("--environment <id>", "Project environment ID"),
    rebindUserTestingScenarioOperation,
    (options: ScenarioOptions & { environment: string }) => ({
      project: options.project,
      scenario: options.scenario,
      environmentId: options.environment,
    }),
  );
}

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
