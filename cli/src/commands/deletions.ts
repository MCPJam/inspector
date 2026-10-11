import type { Command } from "commander";
import { z } from "zod";
import { writeResult } from "../lib/output.js";
import { getGlobalOptions } from "../lib/server-config.js";
import {
  platformOptionsOf,
  runPlatformCommand,
} from "../lib/platform-command.js";

const requestSchema = z.object({
  scope: z.enum(["organization", "project"]),
  id: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(128),
});

export function registerDeletionCommands(program: Command): void {
  const deletions = program
    .command("deletions")
    .description("Request deletion and inspect its receipt");
  deletions
    .command("request")
    .description(
      "Start deletion using an exact scope ID; reuse the key after an uncertain outcome",
    )
    .requiredOption("--scope <type>", "organization or project")
    .requiredOption("--id <id>", "Exact organization or project ID")
    .requiredOption("--idempotency-key <key>", "Stable request key")
    .action(
      async (options: z.input<typeof requestSchema>, command: Command) => {
        const input = requestSchema.parse(options);
        const global = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          global.timeout,
          ({ client, signal }) =>
            client.requestDeletion(
              { scope: { type: input.scope, id: input.id } },
              { signal, idempotencyKey: input.idempotencyKey },
            ),
        );
        writeResult(result, global.format);
      },
    );
  for (const action of ["status", "cancel"] as const) {
    deletions
      .command(action)
      .description(
        action === "status"
          ? "Read a deletion receipt"
          : "Request cancellation while permitted",
      )
      .requiredOption("--request <id>", "Deletion request ID")
      .action(async (options: { request: string }, command: Command) => {
        const requestId = z.string().trim().min(1).parse(options.request);
        const global = getGlobalOptions(command);
        const result = await runPlatformCommand(
          platformOptionsOf(command),
          global.timeout,
          ({ client, signal }) =>
            action === "status"
              ? client.getDeletion({ requestId }, { signal })
              : client.cancelDeletion({ requestId }, { signal }),
        );
        writeResult(result, global.format);
      });
  }
}
