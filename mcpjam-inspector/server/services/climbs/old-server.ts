/**
 * What the real server held when the climb began, from its stored revisions: the
 * newest capture at or before the climb's start. A verification needs it twice:
 * to tell a kept change that is missing from the server (it still lists the old
 * value) from one that differs, and to build the mock that puts the old values
 * back. With no capture that old, nothing can be put back and the verification
 * runs the server alone.
 */
import type { OldServer } from "@mcpjam/sdk/mocks";
import type { ClimbDeps } from "./deps.js";

export async function loadOldServer(
  deps: Pick<ClimbDeps, "client">,
  projectId: string,
  serverId: string,
  climbStartedAt: number,
): Promise<OldServer | undefined> {
  const page = await deps.client.listServerRevisions({ projectId, serverId, limit: 100 });
  const revision = page.items.find((candidate) => candidate.capturedAt <= climbStartedAt);
  if (!revision) return undefined;
  const stored = await deps.client.getServerRevision({ projectId, serverId, revisionNumber: revision.revisionNumber });
  const discovery = stored.discovery ?? {};
  const info = discovery.serverInfo as { name?: string; title?: string; version?: string } | undefined;
  return {
    ...(typeof discovery.instructions === "string" ? { instructions: discovery.instructions } : {}),
    ...(info ? { serverInfo: info } : {}),
    tools: Object.fromEntries(
      stored.tools.map(({ name, title, description, inputSchema, outputSchema, annotations, icons }) => [
        name,
        { title, description, inputSchema, outputSchema, annotations, icons },
      ]),
    ),
    droppedFields: stored.droppedFields,
  };
}
