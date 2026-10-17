import type { Command } from "commander";
import { authorizeLocalExecutionOperation } from "@mcpjam/sdk/platform";
import {
  addProjectOption,
  bindOperation,
  type PlatformOptions,
} from "../lib/platform-command.js";

export function registerLocalExecutionCommands(sessions: Command): void {
  bindOperation(
    addProjectOption(
      sessions
        .command("authorize-local")
        .description(
          "Renew an unattended grant after Add client setup in the local Inspector",
        )
        .requiredOption("--harness <id>", "claude-code or codex")
        .requiredOption(
          "--allow-unattended",
          "Explicitly allow execution without attended approvals",
        )
        .requiredOption(
          "--workspace-grant <id>",
          "Existing workspace grant from local Inspector setup",
        ),
    ),
    authorizeLocalExecutionOperation,
    (
      options: PlatformOptions & {
        project?: string;
        harness: string;
        allowUnattended?: boolean;
        workspaceGrant: string;
      },
    ) =>
      authorizeLocalExecutionOperation.inputSchema.parse({
        project: options.project,
        harnessId: options.harness,
        allowUnattended: options.allowUnattended,
        workspaceGrantId: options.workspaceGrant,
      }),
  );
}
