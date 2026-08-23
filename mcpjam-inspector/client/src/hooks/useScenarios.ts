import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { shouldQueryProjectId } from "./useProjects";
import type { ScenarioHostStyle } from "@/lib/scenario-client-style";
import type {
  ChatUiSettings,
  ScenarioFeedbackDialogSettings,
  ScenarioWelcomeDialogSettings,
} from "@/types/chatUi";

export type {
  ChatUiSettings,
  ScenarioFeedbackDialogSettings,
  ScenarioWelcomeDialogSettings,
};

export type ScenarioMode =
  | "anyone_with_link"
  | "invited_only"
  | "project_members";

export interface ScenarioMember {
  _id: string;
  scenarioId: string;
  projectId: string;
  email: string;
  userId?: string;
  role: "chat";
  invitedBy: string;
  invitedAt: number;
  revokedAt?: number;
  acceptedAt?: number;
  user: {
    _id: string;
    name: string;
    email: string;
    imageUrl: string;
  } | null;
}

export interface ScenarioServerSettings {
  serverId: string;
  serverName: string;
  useOAuth: boolean;
  serverUrl: string | null;
  clientId: string | null;
  oauthScopes: string[] | null;
  /** When true, server is not connected until the tester enables it (off by default). */
  optional?: boolean;
}

export interface ScenarioSettings {
  scenarioId: string;
  projectId: string;
  name: string;
  description?: string;
  /** Projected from the resolved host's hostConfig DTO. */
  hostStyle: ScenarioHostStyle;
  systemPrompt: string;
  modelId: string;
  temperature: number;
  requireToolApproval: boolean;
  allowGuestAccess: boolean;
  mode: ScenarioMode;
  /** Org sharing ceiling from the legacy settings envelope. Absent ⇒ no ceiling. */
  maxShareMode?: ScenarioMode;
  /** Chat UI config envelope: welcome / feedback dialog surfaces (and future surfaces / branding). */
  chatUi?: ChatUiSettings | null;
  servers: ScenarioServerSettings[];
  /** The named host this scenario resolves through. */
  namedHostId: string;
  namedHostName: string;
  /**
   * Environment identity + resolution state, same contract as
   * `ScenarioListItem`: non-null `environmentId` marks a live-follow row,
   * `environmentError` says why it can't resolve. Every settings-returning
   * mutation carries these too (mcpjam-backend #889), so state replaced from
   * a `setScenarioMode` response keeps them.
   */
  environmentId?: string | null;
  environmentName?: string | null;
  environmentError?: { code: string | null; message: string } | null;
  link: {
    token: string;
    path: string;
    url: string;
    rotatedAt: number;
    updatedAt: number;
  } | null;
  members: ScenarioMember[];
  /**
   * Secure Guest Harness Enablement — the per-swarm host-funded guest execution
   * opt-in + caps, read-only advisory state for the admin publish UI. `null`
   * (or absent) ⇒ guest execution disabled. Written via
   * `scenarios:setScenarioGuestExecution` (project-admin gated).
   */
  guestExecution?: GuestExecutionSettings | null;
  /**
   * Production scoring config, verbatim from the row. `null` (or absent) ⇒
   * never configured — the same OFF as `{enabled: false}` for grading,
   * distinct only for the editor's pristine state. Written via
   * `productionChecks:setProductionScoring`.
   */
  productionScoring?: ProductionScoringSettings | null;
}

export interface ProductionScoringSettings {
  enabled: boolean;
  /** Fraction of real sessions graded, in [0, 1]. */
  samplingRate: number;
  rubric: Array<{
    id: string;
    label?: string;
    predicate: Record<string, unknown>;
  }>;
}

export interface GuestExecutionSettings {
  enabled: boolean;
  computerEnabled: boolean;
  sharedSkillsEnabled: boolean;
  dailyCreditCap: number;
  dailyComputerStartCap: number;
  maxConcurrentComputers: number;
  harnessEnabled?: boolean;
  dailyHarnessSpendCapMicros?: number;
  dailyHarnessCallCap?: number;
  maxConcurrentHarnessRuns?: number;
}

export interface ScenarioListItem {
  scenarioId: string;
  projectId: string;
  name: string;
  description?: string;
  hostStyle: ScenarioHostStyle;
  mode: ScenarioMode;
  allowGuestAccess: boolean;
  serverCount: number;
  serverNames: string[];
  /** The named host this scenario resolves through. */
  namedHostId: string;
  namedHostName: string;
  /**
   * Phase 5: non-null iff this scenario is environment-backed (live-follow,
   * mcpjam-backend #805) — for those rows `namedHostId`/`namedHostName` are
   * display-only. Optional so a backend predating the field reads as
   * host-backed.
   */
  environmentId?: string | null;
  /**
   * The environment's name, resolved live (mcpjam-backend #889). Null on
   * host-backed rows — absence means "not environment-backed", never
   * "unnamed". Optional so a backend predating the field reads as absent.
   */
  environmentName?: string | null;
  /**
   * Why an environment-backed row can't resolve right now: its environment
   * was archived, a pinned plugin was disabled, its host is gone. Null when
   * healthy AND on host-backed rows. The row is still projected — a scenario
   * whose share link is live must stay visible to the person who can retire
   * it — so this is what tells the UI to badge it instead of rendering a
   * confident-looking but empty row.
   */
  environmentError?: { code: string | null; message: string } | null;
  /** Shareable link (null until first publish mints one). */
  link?: { token: string; path: string; url: string } | null;
  /**
   * Scenario-list activity columns, maintained as write-time counters on the
   * scenario row (mcpjam-backend). Optional so a deployment predating them
   * renders "—" rather than a confident zero — the two are different claims.
   * Excludes preview and synthetic sessions: a tester is someone who opened
   * the share link.
   *
   * `sessionCount` has no column of its own — it is read by
   * `isDeliberateScenario`, which uses any real tester history as evidence
   * that a row is a scenario someone made rather than a client's auto-minted
   * publish surface.
   */
  uniqueTesterCount?: number;
  sessionCount?: number;
  lastSessionAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export function useScenarioList({
  isAuthenticated,
  projectId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
}) {
  // Skip until `projectId` is a real Convex id: a transient LOCAL id (UUID or
  // `local_`/`project_` placeholder) is truthy but throws an
  // ArgumentValidationError against `listScenarios` during project hydration —
  // the same guard useHostList uses.
  const enabled = isAuthenticated && shouldQueryProjectId(projectId);
  const scenarios = useQuery(
    "scenarios:listScenarios" as any,
    enabled ? ({ projectId } as any) : "skip",
  ) as ScenarioListItem[] | undefined;

  return {
    scenarios,
    isLoading: enabled && scenarios === undefined,
  };
}

/**
 * The scenario published from one environment, or null when it isn't
 * published. Derived from the shared list subscription rather than its own
 * query — two subscriptions to the same rows is two chances to disagree.
 *
 * `undefined` while the list is still loading: "not published" and "we don't
 * know yet" send a viewer to different places.
 */
export function useEnvironmentScenario({
  isAuthenticated,
  projectId,
  environmentId,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
  environmentId: string | null;
}): { scenario: ScenarioListItem | null | undefined; isLoading: boolean } {
  const { scenarios, isLoading } = useScenarioList({
    isAuthenticated,
    projectId,
  });
  const scenario = useMemo(() => {
    if (!environmentId || scenarios === undefined) return undefined;
    return scenarios.find((row) => row.environmentId === environmentId) ?? null;
  }, [scenarios, environmentId]);
  return { scenario, isLoading };
}

/**
 * Publishing an environment as a User Testing scenario, and retiring it.
 *
 * Both are PROJECT-ADMIN gated backend-side (a scenario is shared mutable
 * execution config, and a spend surface) — surface the `FORBIDDEN` copy
 * verbatim rather than paraphrasing it.
 *
 * Publish is idempotent: one scenario per environment, and a second call
 * returns the existing row with `created: false` and IGNORES the overrides,
 * so re-publishing can never silently rename or re-mode a live scenario
 * (mcpjam-backend #887).
 */
export function useEnvironmentScenarioMutations() {
  const publishEnvironmentScenario = useMutation(
    "scenarios:publishEnvironmentScenario" as any,
  ) as (args: {
    environmentId: string;
    name?: string;
    description?: string;
    mode?: ScenarioMode;
  }) => Promise<{
    scenarioId: string;
    environmentId: string;
    name: string;
    mode: ScenarioMode;
    accessVersion: number;
    link: { token: string; path: string; url: string } | null;
    created: boolean;
  }>;
  const unpublishEnvironmentScenario = useMutation(
    "scenarios:unpublishEnvironmentScenario" as any,
  ) as (args: {
    environmentId: string;
  }) => Promise<{ deleted: boolean; scenarioId?: string }>;
  return { publishEnvironmentScenario, unpublishEnvironmentScenario };
}

export function useScenario({
  isAuthenticated,
  scenarioId,
}: {
  isAuthenticated: boolean;
  scenarioId: string | null;
}) {
  const scenario = useQuery(
    "scenarios:getScenario" as any,
    isAuthenticated && scenarioId ? ({ scenarioId } as any) : "skip",
  ) as ScenarioSettings | null | undefined;

  return {
    scenario,
    isLoading: isAuthenticated && !!scenarioId && scenario === undefined,
  };
}

/**
 * Resolve the scenario bound to a host. Under the 1:1 invariant
 * (`hosts.createHost` auto-mints a scenario; `hosts.deleteHost` cascades),
 * every host has exactly one scenario reachable via this query. The new
 * host-detail surfaces use this to drill `scenarioId` into the publish /
 * sessions / clusters tabs without the URL needing to carry scenarioId.
 */
export function useScenarioByHostId({
  isAuthenticated,
  hostId,
}: {
  isAuthenticated: boolean;
  hostId: string | null;
}) {
  const scenario = useQuery(
    "scenarios:getScenarioByHostId" as any,
    isAuthenticated && hostId ? ({ hostId } as any) : "skip",
  ) as ScenarioSettings | null | undefined;

  return {
    scenario,
    isLoading: isAuthenticated && !!hostId && scenario === undefined,
  };
}

export function useScenarioMutations() {
  // `createScenario` / `duplicateScenario` were removed with the 1:1
  // host↔scenario refactor. To create, call `hosts.createHost` (which
  // auto-creates the publish-surface scenario); to duplicate, call
  // `hosts.duplicateHost`. The remaining mutations are the publish-side
  // editors (mode, link rotation, members, name/description/chatUi).
  const updateScenario = useMutation("scenarios:updateScenario" as any);
  const deleteScenario = useMutation("scenarios:deleteScenario" as any);
  const setScenarioMode = useMutation("scenarios:setScenarioMode" as any);
  const rotateScenarioLink = useMutation("scenarios:rotateScenarioLink" as any);
  const upsertScenarioMember = useMutation(
    "scenarios:upsertScenarioMember" as any,
  );
  const removeScenarioMember = useMutation(
    "scenarios:removeScenarioMember" as any,
  );
  // Secure Guest Harness Enablement — project-admin gated per-swarm guest
  // execution + harness opt-in/caps editor.
  const setScenarioGuestExecution = useMutation(
    "scenarios:setScenarioGuestExecution" as any,
  );
  // Production scoring: the grading editor's write. Lives in the
  // `productionChecks` module backend-side, but belongs in this hook — it is
  // a scenario settings editor like the rest.
  const setProductionScoring = useMutation(
    "productionChecks:setProductionScoring" as any,
  );
  // Environment-backed scenarios only: re-point the scenario at a different
  // environment (admin-gated; refuses a target that already backs another
  // scenario). The setup editor on the scenario detail header commits
  // through this.
  const rebindEnvironmentScenario = useMutation(
    "scenarios:rebindEnvironmentScenario" as any,
  );

  return {
    updateScenario,
    deleteScenario,
    setScenarioMode,
    rotateScenarioLink,
    upsertScenarioMember,
    removeScenarioMember,
    setScenarioGuestExecution,
    setProductionScoring,
    rebindEnvironmentScenario,
  };
}
