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
