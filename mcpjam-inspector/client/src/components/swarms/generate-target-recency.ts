/**
 * Which server group to preselect.
 *
 * Connection time alone cannot carry "most recently connected": auto-connect
 * stamps every server at startup in whatever order they settle, so between two
 * groups the newest stamp is arbitrary. Usage wins instead — `lastUsedAt` is
 * the setup the user last worked against — and connection time breaks the tie.
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
  servers: Record<string, RecencyServer> | undefined,
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
  servers: Record<string, RecencyServer> | undefined,
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

export type RecencyEnvironment = {
  /** Absent on a client-default setup, which names no group. */
  serverAttachmentId?: string | null;
  /** Absent on an older backend — no signal, which is not "never used". */
  lastUsedAt?: number;
};

/** The group behind the most recently used setup. */
export function mostRecentlyUsedAttachmentId(
  attachments: readonly RecencyAttachment[],
  environments: readonly RecencyEnvironment[],
): string | null {
  const known = new Set(attachments.map((a) => a._id));
  let best: { id: string; at: number } | null = null;
  for (const environment of environments) {
    const id = environment.serverAttachmentId;
    const at = environment.lastUsedAt;
    if (!id || !known.has(id) || typeof at !== "number") continue;
    if (best === null || at > best.at) best = { id, at };
  }
  return best?.id ?? null;
}

export function preferredAttachmentId({
  attachments,
  environments,
  servers,
}: {
  attachments: readonly RecencyAttachment[];
  environments: readonly RecencyEnvironment[];
  servers: Record<string, RecencyServer> | undefined;
}): string | null {
  return (
    mostRecentlyUsedAttachmentId(attachments, environments) ??
    mostRecentlyConnectedAttachmentId(attachments, servers)
  );
}
