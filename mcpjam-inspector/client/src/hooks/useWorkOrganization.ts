import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useSoftQuery } from "./use-soft-query";

export interface WorkSignupOutcome {
  state:
    | "verification_required"
    | "lookup_pending"
    | "joined"
    | "seat_required"
    | "invitation_required"
    | "unavailable";
  domain: string;
  organizationId?: string;
  organizationName?: string;
  personalOrganizationId?: string;
  routedAt?: number;
  dismissedAt?: number;
}
export interface WorkDomainSettings {
  domain: string;
  organizationId: string;
  automaticJoining: boolean;
  discoverable: boolean;
  revision: number;
  discoveryRevision: number;
  canManageDefault: boolean;
  options: { organizationId: string; name: string }[];
}
export const workSignupAcknowledge = makeFunctionReference<
  "mutation",
  { action: "dismiss" | "routed" },
  null
>("workSignup:acknowledge");
export const workSignupRetry = makeFunctionReference<
  "mutation",
  Record<string, never>,
  null
>("workSignup:retry");
export const ensureWorkProject = makeFunctionReference<
  "mutation",
  { organizationId: string },
  string
>("projects:ensureDefaultProject");
export const saveWorkDomain = makeFunctionReference<
  "mutation",
  {
    domain: string;
    organizationId: string;
    expectedRevision: number;
    automaticJoining: boolean;
    settingsOrganizationId: string;
    discoverable: boolean;
    expectedDiscoveryRevision: number;
  },
  { revision: number }
>("workOrganizationDirectory:updateDefault");
export const saveWorkDiscovery = makeFunctionReference<
  "mutation",
  {
    organizationId: string;
    discoverable: boolean;
    expectedRevision: number;
  },
  null
>("workOrganizationDirectory:setDiscoverable");

export function useWorkOrganization(enabled: boolean) {
  const result = useSoftQuery<WorkSignupOutcome | null>(
    "workSignup:getOutcome",
    enabled ? {} : "skip",
  );
  const acknowledge = useMutation(workSignupAcknowledge);
  const retry = useMutation(workSignupRetry);
  const ensureProject = useMutation(ensureWorkProject);
  return { ...result, acknowledge, retry, ensureProject };
}
