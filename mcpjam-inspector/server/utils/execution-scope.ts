/**
 * Phase 3 guest execution — client-side mirror of the backend's execution-scope
 * contract (docs/plans/phase3-guest-execution-v1.md, mcpjam-backend
 * convex/lib/executionAccess.ts).
 *
 * The backend's runtime-config routes return an `executionScope` (plus advisory
 * accessKind / actorKind / capabilities / runtimeSkills). The inspector threads
 * the OPAQUE `executionScope` back into side-effectful calls (`/computers/reserve`,
 * runtime skills) so the backend RE-RESOLVES live access. The client carries NO
 * enforcement logic — these fields are advisory; the backend is authoritative.
 *
 * All fields are optional on the runtime-config types: a backend that predates
 * Phase 3 omits them, and the inspector falls back to the legacy `{ projectId }`
 * calls — so wiring `executionScope` is behavior-preserving until the backend
 * starts serving it.
 */

import { z } from "zod";

/** Opaque downstream scope echoed back to execution endpoints, never trusted. */
export type ExecutionScope =
  | { kind: "project"; projectId: string }
  | {
      kind: "swarm";
      swarmId: string;
      accessVersion: number;
      projectId: string;
      workspaceId: string;
    };

/**
 * Boundary validator for a FORWARDED scope (the data-plane exec route). The
 * scope is OPAQUE — the backend re-resolves and authorizes it — so this checks
 * the discriminant + the V1 fields but `.passthrough()`es any extra/future
 * backend-only keys rather than stripping them, preserving the value verbatim.
 * The clean `ExecutionScope` type above is what client code constructs/reads.
 */
export const executionScopeSchema = z.union([
  z
    .object({ kind: z.literal("project"), projectId: z.string().min(1) })
    .passthrough(),
  z
    .object({
      kind: z.literal("swarm"),
      swarmId: z.string().min(1),
      accessVersion: z.number(),
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
    })
    .passthrough(),
]);

export type ExecutionAccessKind =
  | "project_member"
  | "guest_owned_project"
  | "swarm_grant";

export type ExecutionActorKind = "signedIn" | "guest";

/** Sanitized capability booleans the backend derived for this actor. */
export type ExecutionCapabilities = {
  computer: boolean;
  sharedSkills: boolean;
  personalSkills: boolean;
  harness: boolean;
};

/**
 * Advisory Phase 3 fields added to BOTH runtime-config responses. All optional
 * so a pre-Phase-3 backend omits them and the inspector stays on the legacy
 * path. The inspector reads `executionScope` (to thread into reserve/skills) and
 * may read `capabilities` / `runtimeSkills` for display, but never enforces with
 * them — the backend re-resolves on every side effect.
 */
export type RuntimeExecutionFields = {
  executionScope?: ExecutionScope;
  accessKind?: ExecutionAccessKind;
  actorKind?: ExecutionActorKind;
  capabilities?: ExecutionCapabilities;
  runtimeSkills?: { shared: boolean; personal: boolean };
};
