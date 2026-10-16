import { noPermalink } from "./permalinks.js";
import { z } from "zod";
import {
  localExecutionAuthorizationSchema,
  type PlatformLocalExecutionGrant,
} from "./local-execution.js";
import type {
  PlatformOperation,
  PlatformOperationContext,
} from "./operations.js";

type ResolveProject = (
  context: PlatformOperationContext,
  selector: string | undefined
) => Promise<{ project: { id: string } }>;
export function createLocalExecutionAuthorizationOperation(
  resolveProjectOrThrow: ResolveProject
): PlatformOperation<
  z.infer<typeof localExecutionAuthorizationSchema> & { project?: string },
  PlatformLocalExecutionGrant
> {
  const inputSchema = localExecutionAuthorizationSchema.extend({
    project: z.string().min(1).optional(),
  });
  return {
    name: "authorize_local_execution",
    title: "Authorize unattended local execution",
    description:
      "Authorize this verified user's local machine and workspace for unattended Claude Code or Codex execution. Requires allowUnattended:true; returns a short-lived capability. Use this target on every local chat turn. Does not approve attended permission requests.",
    readOnly: false,
    mayBeDestructive: true,
    risk: "exposure",
    permalink: noPermalink("mutation-only"),
    inputSchema,
    async execute(input, context) {
      const validated = inputSchema.parse(input);
      const { project } = await resolveProjectOrThrow(
        context,
        validated.project
      );
      const { project: _selector, ...body } = validated;
      return context.client.authorizeLocalExecution(project.id, body, {
        signal: context.signal,
      });
    },
  };
}
