import type { Command } from "commander";
import { authorizeLocalExecutionOperation } from "@mcpjam/sdk/platform";
import { addProjectOption, bindOperation, type PlatformOptions } from "../lib/platform-command.js";

export function registerLocalExecutionCommands(sessions: Command): void {
  bindOperation(
    addProjectOption(
      sessions
        .command("authorize-local")
        .description(
          "Authorize this machine and workspace for unattended local execution"
        )
        .requiredOption("--harness <id>", "claude-code or codex")
        .requiredOption(
          "--allow-unattended",
          "Explicitly allow execution without attended approvals"
        )
        .option(
          "--workspace <path>",
          "Workspace directory; defaults to a managed project workspace"
        )
    ),
    authorizeLocalExecutionOperation,
    (options: PlatformOptions & {
      project?: string;
      harness: string;
      allowUnattended?: boolean;
      workspace?: string;
    }) => authorizeLocalExecutionOperation.inputSchema.parse({
      project: options.project,
      harnessId: options.harness,
      allowUnattended: options.allowUnattended,
      workspacePath: options.workspace,
    })
  );
}
