import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { getFunctionName, makeFunctionReference } from "convex/server";
import {
  decideProjectAccessRequestRef,
  type AccessDecision,
} from "@/components/access-requests/access-request-api";
import { useSoftQuery } from "@/hooks/use-soft-query";
import {
  useOrganizationQueries,
  type Organization,
} from "@/hooks/useOrganizations";

/** `name` is plain ("Acme"); `domain` comes from the server, never the email. */
export type SignupCompanyAnswer = {
  step: "none" | "join" | "owner";
  organizationId?: string;
  name?: string;
  domain?: string;
  joinWithoutApproval?: boolean;
  requestStatus?: "pending" | "declined";
};

export type CompanyStepChoice = "ask" | "join" | "continue" | "setup" | "move";

/** A row with a `projectId` is a project request, which Members & sharing skips. */
export type OrganizationAccessRequestRow = {
  requestId: string;
  userId: string;
  name: string | null;
  email: string;
  requestedAt: number;
  projectId?: string;
};

export const getSignupCompanyStepRef = makeFunctionReference<
  "query",
  Record<string, never>,
  SignupCompanyAnswer
>("workOrganizations:getSignupCompanyStep");
export const resolveSignupCompanyRef = makeFunctionReference<
  "mutation",
  Record<string, never>,
  SignupCompanyAnswer
>("workOrganizations:resolveSignupCompany");
export const completeCompanyStepRef = makeFunctionReference<
  "mutation",
  { choice: CompanyStepChoice },
  { ok: true }
>("workOrganizations:completeCompanyStep");
export const listOrganizationAccessRequestsRef = makeFunctionReference<
  "query",
  { organizationId: string },
  OrganizationAccessRequestRow[]
>("projectAccessRequests:listForOrganization");

export type ShownCompanyStep = {
  step: "join" | "owner";
  organizationId: string;
  name: string;
  domain: string;
};

/** `ask` is one call: the server creates the request. Both reject on failure. */
export type CompanyStepActions = {
  ask: () => Promise<void>;
  continue: () => Promise<void>;
};

export type SignupCompanyGate =
  | { kind: "hidden" }
  | { kind: "resolving" }
  | {
      kind: "show";
      step: ShownCompanyStep;
      personalOrganizationName: string | null;
      actions: CompanyStepActions;
      finish: () => void;
    };

/** A pending or declined request shows no step: Home tells them where it stands. */
export function shownStepOf(
  answer: SignupCompanyAnswer | undefined,
): ShownCompanyStep | null {
  if (!answer || (answer.step !== "join" && answer.step !== "owner")) {
    return null;
  }
  const { organizationId, name, domain, requestStatus } = answer;
  if (!organizationId || !name || !domain || requestStatus) return null;
  return { step: answer.step, organizationId, name, domain };
}

/** `kind: "personal"`, else the organization they created that is not the Work one. */
export function personalOrganizationNameOf(
  organizations: readonly Organization[],
  workOrganizationId: string,
): string | null {
  const personal =
    organizations.find((org) => org.kind === "personal") ??
    organizations.find(
      (org) => org.isCreator === true && org._id !== workOrganizationId,
    );
  return personal?.name ?? null;
}

/**
 * The company step. `eligible` is the role question's population and
 * `roleGateShown` is true while the role is unanswered. Once the role saves,
 * resolveSignupCompany runs once and the gate reads `resolving` until the step
 * query answers. A shown step stays until `finish()`, whatever the server says.
 */
export function useSignupCompanyStep({
  eligible,
  roleGateShown,
}: {
  eligible: boolean;
  roleGateShown: boolean;
}): SignupCompanyGate {
  const queryable = eligible && !roleGateShown;
  // Soft: the app shell renders this, and the app is correct without a step.
  const { data: answer, error } = useSoftQuery<SignupCompanyAnswer>(
    getFunctionName(getSignupCompanyStepRef),
    queryable ? {} : "skip",
  );
  const resolveCompany = useMutation(resolveSignupCompanyRef);
  const completeStep = useMutation(completeCompanyStepRef);
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: eligible,
  });
  const [sawRoleGate, setSawRoleGate] = useState(false);
  const [resolve, setResolve] = useState<
    "idle" | "running" | "settled" | "failed"
  >("idle");
  const resolveStarted = useRef(false);
  const [latched, setLatched] = useState<ShownCompanyStep | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    if (eligible && roleGateShown) setSawRoleGate(true);
  }, [eligible, roleGateShown]);

  const shouldResolve = queryable && sawRoleGate;
  useEffect(() => {
    if (!shouldResolve || resolveStarted.current) return;
    resolveStarted.current = true;
    setResolve("running");
    resolveCompany({}).then(
      () => setResolve("settled"),
      (resolveError: unknown) => {
        console.error(
          "[signup] Failed to resolve the company step",
          resolveError,
        );
        setResolve("failed");
      },
    );
  }, [shouldResolve, resolveCompany]);

  const resolving =
    shouldResolve &&
    (resolve === "idle" ||
      resolve === "running" ||
      (resolve === "settled" && answer === undefined && !error));
  const shown =
    !queryable || finished
      ? null
      : (latched ??
        (resolving || resolve === "failed" ? null : shownStepOf(answer)));

  useEffect(() => {
    if (shown && !latched) setLatched(shown);
  }, [shown, latched]);

  const actions = useMemo<CompanyStepActions>(() => {
    const choose = (choice: "ask" | "continue") => async () => {
      await completeStep({ choice });
    };
    return { ask: choose("ask"), continue: choose("continue") };
  }, [completeStep]);
  const finish = useCallback(() => setFinished(true), []);

  if (!shown) return resolving ? { kind: "resolving" } : { kind: "hidden" };
  const personalOrganizationName = personalOrganizationNameOf(
    sortedOrganizations,
    shown.organizationId,
  );
  return {
    kind: "show",
    step: shown,
    personalOrganizationName,
    actions,
    finish,
  };
}

/** Join requests for Members & sharing; skipped for members and guests. */
export function useOrganizationJoinRequests({
  organizationId,
  enabled,
}: {
  organizationId: string;
  enabled: boolean;
}) {
  const rows = useQuery(
    listOrganizationAccessRequestsRef,
    enabled ? { organizationId } : "skip",
  );
  const decideRequest = useMutation(decideProjectAccessRequestRef);
  const requests = useMemo(
    () => (rows ?? []).filter((row) => !row.projectId),
    [rows],
  );
  const decide = useCallback(
    (requestId: string, decision: AccessDecision) =>
      decideRequest({ requestId, decision }),
    [decideRequest],
  );
  return { requests, decide };
}
