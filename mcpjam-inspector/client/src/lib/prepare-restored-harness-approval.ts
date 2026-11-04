export interface ApprovalServerSelection {
  sessionId: string;
  serverNames: string[];
}

/** Resolve the saved turn's servers before answering its pending approval. */
export async function prepareRestoredHarnessApproval(args: {
  selection: ApprovalServerSelection;
  targetKey: string;
  currentSessionId: () => string;
  currentTargetKey: () => string;
  resolve: (names: string[]) => Promise<Array<{ serverId: string }>>;
}): Promise<{ serverIds: string[]; serverNames: string[] }> {
  const serverNames = [...args.selection.serverNames];
  const resolved = await args.resolve(serverNames);
  if (
    args.currentSessionId() !== args.selection.sessionId ||
    args.currentTargetKey() !== args.targetKey
  ) {
    throw new Error("The chat changed while preparing this approval. Open the original chat to answer it.");
  }
  return { serverNames, serverIds: resolved.map((server) => server.serverId) };
}
