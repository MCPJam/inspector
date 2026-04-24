import { normalizeServerNames } from "@/components/evals/suite-environment-utils";
import { DIRECT_GUEST_SERVER_SELECTION_SENTINEL } from "./session-restore";

export type SessionServerDisplaySource = "used" | "selected" | "none";

export type SessionServerDisplayItem = {
  label: string;
  raw: string;
  unresolved: boolean;
};

export type SessionServerDisplay = {
  items: SessionServerDisplayItem[];
  source: SessionServerDisplaySource;
  unresolvedCount: number;
};

function normalizeServerRefs(serverRefs: readonly string[] | undefined): string[] {
  return normalizeServerNames(serverRefs).filter(
    (serverRef) => serverRef !== DIRECT_GUEST_SERVER_SELECTION_SENTINEL,
  );
}

export function deriveSessionServerDisplay(args: {
  usedServerRefs?: readonly string[];
  selectedServers?: readonly string[];
  serversById: Map<string, string>;
  knownServerNames: Iterable<string>;
}): SessionServerDisplay {
  const usedServerRefs = normalizeServerRefs(args.usedServerRefs);
  const selectedServers = normalizeServerRefs(args.selectedServers);
  const source: SessionServerDisplaySource =
    usedServerRefs.length > 0
      ? "used"
      : selectedServers.length > 0
        ? "selected"
        : "none";
  const activeServerRefs =
    source === "used"
      ? usedServerRefs
      : source === "selected"
        ? selectedServers
        : [];

  const knownServerNames = new Map<string, string>();
  for (const serverName of args.knownServerNames) {
    if (typeof serverName !== "string") {
      continue;
    }
    const trimmed = serverName.trim();
    if (!trimmed) {
      continue;
    }
    knownServerNames.set(trimmed.toLowerCase(), trimmed);
  }

  const items: SessionServerDisplayItem[] = [];
  const seenLabels = new Set<string>();

  for (const serverRef of activeServerRefs) {
    const resolvedName =
      args.serversById.get(serverRef) ??
      knownServerNames.get(serverRef.toLowerCase());
    const label = resolvedName ?? serverRef;
    const dedupeKey = label.toLowerCase();
    if (seenLabels.has(dedupeKey)) {
      continue;
    }
    seenLabels.add(dedupeKey);
    items.push({
      label,
      raw: serverRef,
      unresolved: !resolvedName,
    });
  }

  return {
    items,
    source,
    unresolvedCount: items.filter((item) => item.unresolved).length,
  };
}
