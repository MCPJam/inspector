import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { HostedElicitationRequestEvent } from "@/shared/hosted-elicitation";

const pending = makeFunctionReference<
  "query",
  { projectId: string; chatSessionId: string },
  Array<Omit<HostedElicitationRequestEvent, "kind">>
>("elicitations:listPendingElicitations");

/** The same actor-owned rendezvous can be answered on another Inspector replica. */
export function useOwnedChatElicitations(args: {
  enabled: boolean;
  projectId?: string;
  chatSessionId?: string;
}): HostedElicitationRequestEvent[] {
  const rows = useQuery(
    pending,
    args.enabled && args.projectId && args.chatSessionId
      ? { projectId: args.projectId, chatSessionId: args.chatSessionId }
      : "skip",
  );
  return (rows ?? [])
    .filter(
      (row) =>
        !row.pluginWorkspaceId && row.chatSessionId === args.chatSessionId,
    )
    .map((row) => ({ ...row, kind: "request" }));
}

export function mergeChatElicitations(
  stream: HostedElicitationRequestEvent[],
  owned: HostedElicitationRequestEvent[],
): HostedElicitationRequestEvent[] {
  return [
    ...new Map(
      [...owned, ...stream].map((row) => [row.rendezvousId, row]),
    ).values(),
  ];
}
