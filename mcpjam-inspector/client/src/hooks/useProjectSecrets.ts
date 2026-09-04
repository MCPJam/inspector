import { useAction, useConvexAuth, useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";

/**
 * Client hooks for **Project secrets** (mcpjam-backend
 * `convex/projectSecrets.ts` + `convex/projectSecretsNode.ts`).
 *
 * A project secret is a named credential a real workflow needs — `STRIPE_API_KEY`
 * for a `stripe` CLI run, `GH_TOKEN` for `gh` — that an environment grants to
 * the runs launched from it.
 *
 * ## The browser never sees a value
 *
 * `useProjectSecrets` returns METADATA ONLY, and there is deliberately no hook
 * that returns a value: no such query exists on the backend, so one could not
 * be written here. After a create or a rotate, the form clears its field and
 * the value is gone from this process — the row that comes back is the same
 * metadata every list shows.
 *
 * ## Writes are ACTIONS, not mutations
 *
 * Encryption is Node-only in Convex, so the three writes are `useAction`. That
 * also means they are NOT optimistic and NOT reactive: an action's result does
 * not update a query subscription on its own. The reactive `listSecrets` query
 * does re-run when the row lands, which is why the UI reads from it rather than
 * from the action's return value.
 *
 * Like every backend surface here, Convex functions are referenced by string id
 * and the types below are hand-mirrored (no codegen).
 */

export type SecretDelivery = "brokered" | "materialized";
export type SecretSharing = "user" | "project";

/**
 * One secret, as the UI sees it. Note the absence of a value field: it is not
 * omitted from this type, it does not exist on the backend view.
 */
export interface ProjectSecretView {
  secretId: string;
  projectId: string;
  /** The environment-variable name. Immutable — renaming is delete-and-recreate. */
  name: string;
  description?: string;
  /**
   * `brokered` — injected by the sandbox's egress proxy OUTSIDE the VM, so the
   * box never holds it. Prevents EXTRACTION, not USE. HTTPS APIs only.
   * `materialized` — a real environment variable inside the box, which is the
   * only thing a CLI can read. Extractable by design.
   */
  delivery: SecretDelivery;
  brokerHosts?: string[];
  brokerHeader?: string;
  brokerTemplate?: string;
  /**
   * `project` — admin-managed, delivered to every member's sessions.
   * `user` — personal; delivered ONLY in sessions its owner starts.
   */
  sharing: SecretSharing;
  /** Personal rows only. */
  ownerUserId?: string;
  /** True when this is the viewer's own personal secret. */
  isOwner: boolean;
  /**
   * When the secret was last HANDED TO a run — not when it was last used.
   * Brokered use is unobservable by construction, so "used" would be a number
   * nobody can honestly produce. Absent means nothing has been recorded.
   */
  lastDeliveredAt?: number;
  createdAt: number;
  updatedAt: number;
  createdByUserId: string;
  updatedByUserId: string;
}

/**
 * The project's secrets, metadata only.
 *
 * `undefined` while loading. Returns project-shared rows plus the VIEWER'S OWN
 * personal ones — another member's personal secret is absent entirely, so the
 * UI never has to filter for it and never renders a row it could not act on.
 */
export function useProjectSecrets(
  projectId: string | null | undefined,
): ProjectSecretView[] | undefined {
  const { isAuthenticated } = useConvexAuth();
  const dbUserReady = useDbUserReady();
  return useQuery(
    "projectSecrets:listSecrets" as any,
    isAuthenticated && dbUserReady && shouldQueryProjectId(projectId)
      ? ({ projectId } as any)
      : "skip",
  ) as ProjectSecretView[] | undefined;
}

/**
 * Create a secret.
 *
 * The value crosses exactly one boundary: this call. It is not stored in
 * component state beyond the submit, not echoed into the returned row, and not
 * recoverable afterwards — the form should clear its field on success and say
 * so, rather than leaving the impression the value can be re-read.
 *
 * `sharing: "project"` requires project admin; the backend refuses a non-admin
 * rather than silently downgrading to personal, because a silent downgrade
 * looks like success and then reaches nobody else's sessions.
 */
export function useCreateProjectSecret(): (args: {
  projectId: string;
  name: string;
  value: string;
  description?: string;
  delivery: SecretDelivery;
  /** Required iff `delivery === "brokered"`; rejected otherwise. */
  brokerHosts?: string[];
  brokerHeader?: string;
  brokerTemplate?: string;
  sharing?: SecretSharing;
}) => Promise<ProjectSecretView> {
  return useAction("projectSecretsNode:createSecret" as any) as never;
}

/**
 * Rotate a value and/or edit the delivery binding.
 *
 * ROTATION REACHES NEW RUNS ONLY. A session already running holds the old
 * value — materialized in its box's environment, or inside an egress policy
 * that cannot be read back — so the UI should say that rather than implying the
 * change is immediate everywhere.
 *
 * `name` and `sharing` are absent because both are immutable: renaming breaks
 * the workflows referencing the environment variable, and re-sharing changes
 * who has already been handed the value.
 */
export function useUpdateProjectSecret(): (args: {
  projectId: string;
  secretId: string;
  value?: string;
  /** `null` clears the description; omit to leave it unchanged. */
  description?: string | null;
  delivery?: SecretDelivery;
  brokerHosts?: string[];
  brokerHeader?: string;
  brokerTemplate?: string;
}) => Promise<ProjectSecretView> {
  return useAction("projectSecretsNode:updateSecret" as any) as never;
}

/**
 * Revoke a secret. HARD — the row and the ciphertext both go.
 *
 * Deliberately NOT blocked when an environment still selects it: the selection
 * resolver drops ids that no longer resolve, and refusing would make a leaked
 * credential un-revokable until someone edited every environment naming it. The
 * confirm dialog names those environments so the user knows what stops working;
 * it does not stop them.
 */
export function useDeleteProjectSecret(): (args: {
  projectId: string;
  secretId: string;
}) => Promise<{ deleted: true; secretId: string; name: string }> {
  return useAction("projectSecretsNode:deleteSecret" as any) as never;
}
