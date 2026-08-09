import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";

/**
 * Org-level settings for the Slack agent.
 *
 * Reads are Convex subscriptions, so a second admin's edit lands in this tab
 * without a refresh — which matters here specifically: two admins editing the
 * same channel-binding table is exactly the case where a stale list produces a
 * confusing "already bound" error.
 *
 * Every query is gated on `useDbUserReady` as well as `isAuthenticated`: the
 * `users` row is created by `users:ensureUser` after sign-in, and a query that
 * fires before it exists throws inside `requireOrgRole` rather than returning
 * empty.
 */

export interface SlackConnectedWorkspace {
  surfaceKind: "slack";
  surfaceTenantId: string;
  name: string;
  /** False when the org's members use a workspace the app is not installed in. */
  installed: boolean;
  linkedMemberCount: number;
  defaultProjectId: string | null;
  configuredAt: number | null;
}

export interface SlackChannelBinding {
  _id: string;
  surfaceKind: "slack";
  surfaceTenantId: string;
  channelId: string;
  projectId: string;
  createdAt: number;
  lastTestedAt: number | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestError: string | null;
}

export interface SlackConnections {
  workspaces: SlackConnectedWorkspace[];
  channelBindings: SlackChannelBinding[];
}

export interface UseOrgSlackSettingsResult {
  connections: SlackConnections | undefined;
  isLoading: boolean;
  /** The last write's failure, cleared when the next write starts. */
  error: string | null;
  isSaving: boolean;
  setOrgDefaultProject: (args: {
    surfaceTenantId: string;
    projectId?: string;
  }) => Promise<void>;
  createChannelBinding: (args: {
    surfaceTenantId: string;
    channelId: string;
    projectId: string;
  }) => Promise<void>;
  removeChannelBinding: (bindingId: string) => Promise<void>;
  sendTestNotification: (bindingId: string) => Promise<void>;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) {
    // Convex prefixes thrown errors with the server stack; the last line is
    // the message an admin can act on ("That channel is already bound…").
    const lines = error.message.split("\n").filter(Boolean);
    const last = lines[lines.length - 1] ?? error.message;
    return last.replace(/^\[.*?\]\s*/, "").trim() || error.message;
  }
  return String(error);
}

/**
 * A write that belongs to ONE org, and knows it.
 *
 * Both hooks in this file need the same three things, and getting any of them
 * subtly wrong shows up only when an admin switches orgs mid-write:
 *
 *   - The error and saving flags reset when the org changes, so a failure does
 *     not follow the admin to a page where nothing failed.
 *   - A completion that lands after a switch reports to nobody, rather than
 *     putting "That channel is already bound" on a page about a different org.
 *   - The error is surfaced, never swallowed: the conflict message IS the
 *     product here — it is what tells an admin why their binding did not take.
 *
 * Kept in one place because two copies of stale-write logic will diverge, and
 * the divergence would be invisible until someone hits exactly this race.
 */
function useOrgScopedWrite(organizationId: string | null): {
  error: string | null;
  isSaving: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>;
} {
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** The org currently on screen, for a write to compare itself against. */
  const currentOrgRef = useRef(organizationId);

  useEffect(() => {
    currentOrgRef.current = organizationId;
    setError(null);
    setIsSaving(false);
  }, [organizationId]);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      // A mutation is a round trip, and the org picker is one click away. The
      // org it started under is captured here so a completion that arrives
      // after a switch reports to nobody instead of to the wrong page.
      const startedFor = organizationId;
      setError(null);
      setIsSaving(true);
      try {
        await work();
      } catch (nextError) {
        if (currentOrgRef.current === startedFor) {
          setError(messageOf(nextError));
        }
        throw nextError;
      } finally {
        if (currentOrgRef.current === startedFor) setIsSaving(false);
      }
    },
    [organizationId]
  );

  return { error, isSaving, run };
}

export function useOrgSlackSettings(
  organizationId: string | null
): UseOrgSlackSettingsResult {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const connections = useQuery(
    "slackAgentSettings:getConnections" as any,
    enabled ? ({ organizationId } as any) : "skip"
  ) as SlackConnections | undefined;

  const setDefault = useMutation(
    "slackAgentSettings:setOrgDefaultProject" as any
  );
  const createBinding = useMutation(
    "slackAgentSettings:createChannelBinding" as any
  );
  const removeBinding = useMutation(
    "slackAgentSettings:removeChannelBinding" as any
  );
  const sendTestNotificationMutation = useMutation(
    "slackAgentSettings:sendTestNotification" as any
  );

  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const setOrgDefaultProject = useCallback(
    async (args: { surfaceTenantId: string; projectId?: string }) => {
      if (!organizationId) return;
      await run(() =>
        setDefault({
          organizationId,
          surfaceTenantId: args.surfaceTenantId,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        } as any)
      );
    },
    [organizationId, run, setDefault]
  );

  const createChannelBinding = useCallback(
    async (args: {
      surfaceTenantId: string;
      channelId: string;
      projectId: string;
    }) => {
      if (!organizationId) return;
      await run(() => createBinding({ organizationId, ...args } as any));
    },
    [createBinding, organizationId, run]
  );

  const removeChannelBinding = useCallback(
    async (bindingId: string) => {
      if (!organizationId) return;
      await run(() => removeBinding({ organizationId, bindingId } as any));
    },
    [organizationId, removeBinding, run]
  );

  const sendTestNotification = useCallback(
    async (bindingId: string) => {
      if (!organizationId) return;
      await run(() =>
        sendTestNotificationMutation({ organizationId, bindingId } as any)
      );
    },
    [organizationId, run, sendTestNotificationMutation]
  );

  return useMemo(
    () => ({
      connections,
      // "Not enabled yet" is still NO ANSWER, not an empty org. `enabled`
      // stays false while `isAuthenticated`/`useDbUserReady` settle, and a
      // consumer told isLoading=false in that window renders its empty state —
      // asserting "no Slack workspaces yet" before anything was read.
      isLoading: Boolean(organizationId) && connections === undefined,
      error,
      isSaving,
      setOrgDefaultProject,
      createChannelBinding,
      removeChannelBinding,
      sendTestNotification,
    }),
    [
      connections,
      createChannelBinding,
      organizationId,
      error,
      isSaving,
      removeChannelBinding,
      sendTestNotification,
      setOrgDefaultProject,
    ]
  );
}

// ---------------------------------------------------------------------------
// Capability policy
// ---------------------------------------------------------------------------

/** One operation, as the server's registry describes it. */
export interface AgentOpCatalogEntry {
  name: string;
  title: string;
  description: string;
  tier: "direct" | "gated";
  readOnly: boolean;
  gatedKind?: string;
  confirmSeverity?: string;
}

export interface UseOrgSlackCapabilitiesResult {
  disabledOperations: string[] | undefined;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  setDisabledOperations: (names: string[]) => Promise<void>;
}

export function useOrgSlackCapabilities(
  organizationId: string | null
): UseOrgSlackCapabilitiesResult {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const enabled = Boolean(organizationId) && isAuthenticated && isUserReady;

  const policy = useQuery(
    "slackAgentSettings:getCapabilityPolicy" as any,
    enabled ? ({ organizationId } as any) : "skip"
  ) as { disabledOperations: string[] } | undefined;

  const savePolicy = useMutation(
    "slackAgentSettings:setCapabilityPolicy" as any
  );
  const { error, isSaving, run } = useOrgScopedWrite(organizationId);

  const setDisabledOperations = useCallback(
    async (names: string[]) => {
      if (!organizationId) return;
      await run(() =>
        // WHOLE-LIST replacement, matching the mutation: the page shows every
        // operation with a toggle, so what the admin is expressing is a
        // complete state — a delta API would race two admins into a merge
        // neither asked for.
        savePolicy({
          organizationId,
          disabledOperations: names,
        } as any)
      );
    },
    [organizationId, run, savePolicy]
  );

  return useMemo(
    () => ({
      disabledOperations: policy?.disabledOperations,
      // Same reasoning as `useOrgSlackSettings`: an unread policy must not be
      // reported as a settled empty one.
      isLoading: Boolean(organizationId) && policy === undefined,
      error,
      isSaving,
      setDisabledOperations,
    }),
    [organizationId, error, isSaving, policy, setDisabledOperations]
  );
}
