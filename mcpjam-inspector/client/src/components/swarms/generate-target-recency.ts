/**
 * Which server group to preselect: the one whose servers connected most
 * recently. Same ordering `ActiveServerSelector` uses to pick a server.
 *
 * `lastConnectionTime` lives in client runtime state, so a viewer with no
 * connection history gets `null` and the caller keeps its own default.
 */

export type RecencyAttachment = {
  _id: string;
  resolvedServerNames: string[];
};

export type RecencyServer = {
  lastConnectionTime?: Date | string | number | null;
};

function connectedAt(server: RecencyServer | undefined): number {
  if (!server?.lastConnectionTime) return 0;
  const ms = new Date(server.lastConnectionTime).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** A group is as recent as its most recently connected member. */
export function attachmentConnectedAt(
  attachment: RecencyAttachment,
  servers: Record<string, RecencyServer> | undefined
): number {
  if (!servers) return 0;
  let newest = 0;
  for (const name of attachment.resolvedServerNames ?? []) {
    const at = connectedAt(servers[name]);
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * Ties break toward the earlier entry so the answer is stable across renders —
 * two groups sharing a server carry the same timestamp.
 */
export function mostRecentlyConnectedAttachmentId(
  attachments: readonly RecencyAttachment[],
  servers: Record<string, RecencyServer> | undefined
): string | null {
  let best: { id: string; at: number } | null = null;
  for (const attachment of attachments) {
    const at = attachmentConnectedAt(attachment, servers);
    if (at > 0 && (best === null || at > best.at)) {
      best = { id: attachment._id, at };
    }
  }
  return best?.id ?? null;
}
