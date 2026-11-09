import { logger } from "../logger.js";
import { shellQuote } from "./shell-quote.js";

/** The slice of a sandbox session that can run one shell command. */
type CommandSession = {
  run(args: {
    command: string;
    abortSignal?: AbortSignal;
  }): PromiseLike<{ exitCode: number; stdout: string; stderr: string }>;
};

/** Where the bootstrap puts the Cursor CLI's private home, relative to its root. */
const CURSOR_CLI_AUTH = "implementation/home/.config/cursor/auth.json";

/**
 * The command that removes every `auth.json` the Cursor CLI can have written
 * for one session: under the private CLI home the bootstrap installs beneath
 * the session workdir or the box home (the two framework layouts), and under
 * the box home itself. The workdir is host-configured, so it is quoted; the
 * rest is expanded by the box's shell.
 *
 * Only `auth.json`. The CLI's session state, which `session/load` resumes
 * from, lives under `.cursor/` and is never named here.
 */
export function cursorCredentialCleanupCommand(sessionWorkDir: string): string {
  return [
    "rm -f --",
    shellQuote(`${sessionWorkDir}/.harness-bootstrap/cursor/${CURSOR_CLI_AUTH}`),
    `"$HOME/.ai-sdk-harness/.harness-bootstrap/cursor/${CURSOR_CLI_AUTH}"`,
    `"$HOME/.harness-bootstrap/cursor/${CURSOR_CLI_AUTH}"`,
    '"$HOME/.config/cursor/auth.json"',
    '${XDG_CONFIG_HOME:+"$XDG_CONFIG_HOME/cursor/auth.json"}',
  ].join(" ");
}

/**
 * Remove the files where a runtime keeps the vendor tokens it exchanged for
 * its key: Cursor's CLI writes an access and a refresh token to `auth.json` on
 * its first authenticated call. Run at every turn end, so a paused or reused
 * box carries none between turns; the CLI exchanges the placeholder key again,
 * through egress, when it next starts. Fail-soft: the turn has already
 * finished, so a failure is logged and never thrown.
 */
export async function removeRuntimeCredentials(args: {
  adapter: {
    id: string;
    runtimeCredentialCleanupCommand?: (sessionWorkDir: string) => string;
  };
  session: CommandSession;
  sessionWorkDir: string;
  signal: AbortSignal;
}): Promise<void> {
  const command = args.adapter.runtimeCredentialCleanupCommand?.(
    args.sessionWorkDir,
  );
  if (!command) return;
  try {
    const result = await args.session.run({
      command,
      abortSignal: args.signal,
    });
    if (result.exitCode === 0) return;
    logger.warn("[harness] runtime credential cleanup failed", {
      harness: args.adapter.id,
      exitCode: result.exitCode,
    });
  } catch (error) {
    logger.warn("[harness] runtime credential cleanup failed", {
      harness: args.adapter.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
