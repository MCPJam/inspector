import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { ServerFormData } from "@/shared/types.js";
import type { RegistryServer } from "@/lib/registry-server-types";
import type { OrgRegistryDerivedSnapshot } from "@/lib/apis/web/org-registry-api";
import { REGISTRY_FEATURE_ENABLED } from "./useRegistryServers";

/**
 * The organization's own registry shelf.
 *
 * Separate from `useRegistryServers` rather than a branch inside it, and the
 * reason is the STATUS JOIN — the one thing here that is easy to get wrong and
 * expensive when it is.
 *
 * The curated hook decides "is this card connected?" by looking the card's
 * display name up in the live-servers map. That works for curated entries
 * because their names are minted by the connect mutation and nothing else
 * creates a server by that name. It does NOT work for org entries: PROMOTE
 * creates an entry FROM a server that already exists, so the entry and that
 * server share a display name in the project it came from. A name join would
 * show the card as connected in a project that never installed it — and worse,
 * the Disconnect it offers would delete the user's original server.
 *
 * So the join here is PROVENANCE FIRST. A card is added/connected only when
 * this project has a `registryServerConnections` row for it, and the live
 * server is then found by THAT ROW's `serverName`. The display name is never
 * consulted. The consequence is deliberate: a promoted entry reads as
 * "connected" in its source project (which has the provenance row the promote
 * wrote) and as "not connected" everywhere else, until someone connects it.
 */

export interface OrgRegistryServer extends RegistryServer {
  derived?: OrgRegistryDerivedSnapshot;
  editedFields?: string[];
}

export type OrgRegistryConnectionStatus =
  | "not_connected"
  | "added"
  | "connected"
  | "connecting";

export interface EnrichedOrgRegistryServer extends OrgRegistryServer {
  connectionStatus: OrgRegistryConnectionStatus;
  /** The live server this entry's provenance points at, when there is one. */
  connectedServerName: string | null;
  connectionKind?: "installed" | "promoted_source";
}

/** One row of `registryServers:getProjectRegistryConnections`. */
interface RegistryConnectionRow {
  _id: string;
  registryServerId: string;
  serverId: string;
  /** The `servers` row's name, or null if it was deleted underneath. */
  serverName: string | null;
  connectionKind?: "installed" | "promoted_source";
}

export interface OrgRegistryContext {
  organizationId: string | null;
  canAdd: boolean;
}

export interface OrgRegistrySubmission {
  registryServerId?: string;
  displayName: string;
  description?: string;
  url: string;
  useOAuth?: boolean;
  oauthScopes?: string[];
  /** Absent when no probe produced a verdict; never synthesized. */
  derived?: OrgRegistryDerivedSnapshot;
  sourceServerId?: string;
}

/**
 * A Convex query for a function the deployed backend does not have yet reads
 * as a thrown "Could not find public function". The Registry tab must survive
 * that: the org section is new, and a browser can outlive a rollback.
 *
 * `useQuery` throws during render, so this cannot be caught here — the caller
 * wraps the section in an error boundary. What this hook guarantees is the
 * quieter half: an ABSENT answer (still loading, or skipped) is an empty
 * shelf, never a crash and never a spinner that lasts forever.
 */
export function useOrgRegistryServers({
  enabled: callerEnabled = true,
  projectId,
  isAuthenticated,
  liveServers,
  onConnect,
  onDisconnect,
}: {
  enabled?: boolean;
  projectId: string | null;
  isAuthenticated: boolean;
  liveServers?: Record<string, { connectionStatus: string }>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
}) {
  const enabled =
    REGISTRY_FEATURE_ENABLED && callerEnabled && isAuthenticated && !!projectId;

  const rows = useQuery(
    "registryServers:listOrgRegistryServers" as any,
    enabled ? ({ projectId } as any) : "skip"
  ) as OrgRegistryServer[] | undefined;

  const context = useQuery(
    "registryServers:getOrgRegistryContext" as any,
    enabled ? ({ projectId } as any) : "skip"
  ) as OrgRegistryContext | undefined;

  const connections = useQuery(
    "registryServers:getProjectRegistryConnections" as any,
    enabled ? ({ projectId } as any) : "skip"
  ) as RegistryConnectionRow[] | undefined;

  const addMutation = useMutation(
    "registryServers:addOrgRegistryServer" as any
  );
  const updateMutation = useMutation(
    "registryServers:updateOrgRegistryServer" as any
  );
  const removeMutation = useMutation(
    "registryServers:removeOrgRegistryServer" as any
  );
  const connectMutation = useMutation(
    "registryServers:connectRegistryServer" as any
  );
  const disconnectMutation = useMutation(
    "registryServers:disconnectRegistryServer" as any
  );

  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());

  /** registryServerId → the provenance row this project holds for it. */
  const provenance = useMemo(() => {
    const byRegistryId = new Map<string, RegistryConnectionRow>();
    for (const connection of connections ?? []) {
      byRegistryId.set(connection.registryServerId, connection);
    }
    return byRegistryId;
  }, [connections]);

  const servers = useMemo<EnrichedOrgRegistryServer[]>(() => {
    // `connections` must be RESOLVED, not merely absent. The two queries land
    // independently, and if rows arrive first, an empty provenance map reads
    // as "nothing is installed" — every already-installed card would flash
    // "Connect", and a click in that window would try to install it twice.
    // An unresolved provenance query is a loading state, not an answer.
    if (!enabled || !rows || connections === undefined) return [];
    return rows.map((row) => {
      const connection = provenance.get(row._id);
      const connectedServerName = connection?.serverName ?? null;
      const liveServer = connectedServerName
        ? liveServers?.[connectedServerName]
        : undefined;

      let connectionStatus: OrgRegistryConnectionStatus = "not_connected";
      if (connectingIds.has(row._id)) {
        connectionStatus = "connecting";
      } else if (liveServer?.connectionStatus === "connected") {
        connectionStatus = "connected";
      } else if (liveServer?.connectionStatus === "connecting") {
        connectionStatus = "connecting";
      } else if (connection) {
        // Provenance without a live server: installed in this project, not
        // currently up. "Added" rather than "connected" — the distinction the
        // curated cards already draw.
        connectionStatus = "added";
      }

      return {
        ...row,
        connectionStatus,
        connectedServerName,
        connectionKind: connection?.connectionKind,
      };
    });
  }, [enabled, rows, connections, provenance, liveServers, connectingIds]);

  const add = useCallback(
    async (submission: OrgRegistrySubmission) => {
      if (!context?.organizationId) {
        throw new Error("This project is not part of an organization.");
      }
      if (!submission.derived) {
        // `addOrgRegistryServer` requires the snapshot, and the two doors that
        // reach here both produce one (the paste flow probes, promote reads
        // `initializationInfo`). Refusing beats minting a fake.
        throw new Error(
          "We could not read this server's details. Try the address again."
        );
      }
      await addMutation({
        organizationId: context.organizationId,
        displayName: submission.displayName,
        description: submission.description,
        url: submission.url,
        useOAuth: submission.useOAuth,
        oauthScopes: submission.oauthScopes,
        derived: submission.derived,
        sourceServerId: submission.sourceServerId,
      } as any);
    },
    [addMutation, context?.organizationId]
  );

  const update = useCallback(
    async (submission: OrgRegistrySubmission) => {
      if (!submission.registryServerId) {
        throw new Error("Missing registry entry id");
      }
      await updateMutation({
        registryServerId: submission.registryServerId,
        displayName: submission.displayName,
        description: submission.description ?? "",
        url: submission.url,
        useOAuth: submission.useOAuth,
        oauthScopes: submission.oauthScopes,
        derived: submission.derived,
      } as any);
    },
    [updateMutation]
  );

  const remove = useCallback(
    async (registryServerId: string) => {
      await removeMutation({ registryServerId } as any);
    },
    [removeMutation]
  );

  /**
   * MUTATION FIRST, then hand off to the app's own connect — the directory
   * flow's ordering, not the curated one's.
   *
   * The mutation checks org membership, checks the project belongs to that
   * org, creates the `servers` row and writes the provenance record, all
   * BEFORE anything can redirect the browser. The curated flow connects first
   * and records provenance from a later effect, which loses the record
   * whenever OAuth navigates away mid-flight. Here the record exists before
   * the redirect can happen.
   *
   * Resolving means INSTALLED, not connected: `onConnect` returns void and an
   * OAuth server continues asynchronously, possibly through a full page
   * navigation. The card learns the rest from the live-servers map.
   */
  const connect = useCallback(
    async (server: EnrichedOrgRegistryServer) => {
      if (!projectId) {
        throw new Error("Select a project first.");
      }
      setConnectingIds((prev) => new Set(prev).add(server._id));
      try {
        await connectMutation({
          registryServerId: server._id,
          projectId,
        } as any);

        onConnect({
          name: server.displayName,
          type: "http",
          url: server.transport.url,
          // RUNTIME-PROBED, not metadata-trusted — the directory flow's
          // posture. `auto` connects unauthenticated and escalates only on a
          // real 401, so a stored `useOAuth` that has gone stale cannot turn
          // into a server that silently never authorizes. `useOAuth: true` is
          // the compat mirror of `auto` that `handleConnect` gates the whole
          // discover-and-escalate branch on.
          authMethod: "auto",
          useOAuth: true,
          oauthScopes: server.transport.oauthScopes,
          registryServerId: server._id,
        });
      } finally {
        setConnectingIds((prev) => {
          const next = new Set(prev);
          next.delete(server._id);
          return next;
        });
      }
    },
    [connectMutation, onConnect, projectId]
  );

  /**
   * Disconnect acts through the PROVENANCE ROW and nothing else.
   *
   * `disconnectRegistryServer` deletes the `servers` row its connection points
   * at. With no provenance row in this project there is nothing this card
   * installed here, so there is nothing for it to take down — and the server
   * that merely shares its name (the promote case) is somebody else's.
   */
  const disconnect = useCallback(
    async (server: EnrichedOrgRegistryServer) => {
      if (!projectId) return;
      if (!server.connectedServerName) return;
      await disconnectMutation({
        registryServerId: server._id,
        projectId,
      } as any);
      if (server.connectionKind !== "promoted_source") {
        onDisconnect?.(server.connectedServerName);
      }
    },
    [disconnectMutation, onDisconnect, projectId]
  );

  return {
    servers,
    /** Absent answer ⇒ empty shelf, never an endless spinner. */
    isLoading: enabled && (rows === undefined || connections === undefined),
    organizationId: context?.organizationId ?? null,
    canAdd: context?.canAdd ?? false,
    add,
    update,
    remove,
    connect,
    disconnect,
  };
}
