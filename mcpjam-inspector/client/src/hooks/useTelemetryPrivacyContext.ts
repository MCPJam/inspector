import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import {
  CONSERVATIVE_TELEMETRY_POLICY,
  isTelemetryPolicy,
  MAX_TELEMETRY_CONTEXT_IDS,
  type TelemetryIdentity,
  type TelemetryPolicy,
} from "@/shared/telemetry-privacy";

// The backend's query, by name: this package does not import the backend's
// generated API.
const GET_TELEMETRY_CONTEXT = makeFunctionReference<"query">(
  "telemetryPrivacy:getContext",
);

/** The actor key used for a visitor with no session at all. */
export const ANONYMOUS_TELEMETRY_ACTOR = "anonymous";

export interface TelemetryPrivacyContextInput {
  /** Off when this surface never asks (npx/Docker, or no Convex). */
  enabled: boolean;
  /**
   * The current actor: a user or guest id, `null` for a visitor with no
   * session, `undefined` while that is still resolving.
   */
  actor: string | null | undefined;
  /**
   * Changes whenever the actor's memberships reload. A change drops the
   * current answer and asks again, so a membership change is never read
   * through an answer computed before it.
   */
  membershipKey: string;
  projectIds: ReadonlyArray<string | null | undefined>;
  organizationIds: ReadonlyArray<string | null | undefined>;
}

export interface TelemetryPrivacyContextState {
  /**
   * The backend's answer for the contexts in view now; `undefined` until it
   * has answered for exactly these contexts.
   */
  policy: TelemetryPolicy | undefined;
  /**
   * The identity mode, from the latest answer for this actor and these
   * memberships. Unlike `policy` it carries across a change of contexts:
   * whether a person may be named follows their memberships (anyone who can
   * see an organization with enterprise privacy belongs to it, and is
   * id-only everywhere), so switching projects does not unname and rename
   * them. An actor or membership change drops it to `undefined`.
   */
  identity: TelemetryIdentity | undefined;
  /** The actor both were resolved for; `null` for an anonymous visitor. */
  actor: string | null;
}

/**
 * A key that changes whenever the actor's memberships reload: the
 * organizations, the role in each, and their privacy settings.
 */
export function telemetryMembershipKey(
  organizations:
    | ReadonlyArray<{
        _id: string;
        myRole?: string;
        enterprisePrivacy?: boolean;
      }>
    | undefined,
): string {
  if (!organizations) return "loading";
  return organizations
    .map(
      (org) =>
        `${org._id}:${org.myRole ?? ""}:${org.enterprisePrivacy === true ? 1 : 0}`,
    )
    .sort()
    .join(",");
}

function cleanIds(ids: ReadonlyArray<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => !!id))]
    .sort()
    .slice(0, MAX_TELEMETRY_CONTEXT_IDS);
}

/**
 * The backend's telemetry privacy policy (`telemetryPrivacy:getContext`) for
 * the contexts in view, reactively.
 *
 * Stale answers are structurally impossible to read as current ones. The
 * subscription is keyed on the actor and the membership key, and a change to
 * either first renders with the query SKIPPED — dropping the old answer from
 * Convex's local cache — and only subscribes again on the next commit. By
 * then `ConvexProviderWithAuth` has already handed Convex the new actor's
 * token (it pauses the socket while it does), so the fresh subscription is
 * answered under the new identity. Changing the contexts in view changes the
 * query's arguments, which Convex never answers from another argument set's
 * result. Until an answer arrives the policy is `undefined`.
 *
 * Never throws into the render: a query error reads as the conservative
 * policy.
 */
export function useTelemetryPrivacyContext(
  input: TelemetryPrivacyContextInput,
): TelemetryPrivacyContextState {
  const actorKey =
    input.actor === undefined
      ? undefined
      : (input.actor ?? ANONYMOUS_TELEMETRY_ACTOR);
  const subscriptionKey =
    input.enabled && actorKey !== undefined
      ? `${actorKey}\n${input.membershipKey}`
      : null;
  const [activeKey, setActiveKey] = useState<string | null>(null);
  useEffect(() => {
    setActiveKey(subscriptionKey);
  }, [subscriptionKey]);

  // Ids are Convex ids: never a `,` or a `|`, so the key round-trips.
  const argsKey = `${cleanIds(input.projectIds).join(",")}|${cleanIds(
    input.organizationIds,
  ).join(",")}`;
  const subscribed = subscriptionKey !== null && activeKey === subscriptionKey;

  const queries = useMemo((): Parameters<typeof useQueries>[0] => {
    if (!subscribed) return {};
    const [projects, organizations] = argsKey.split("|");
    return {
      policy: {
        query: GET_TELEMETRY_CONTEXT,
        args: {
          projectIds: projects ? projects.split(",") : [],
          organizationIds: organizations ? organizations.split(",") : [],
        },
      },
    };
  }, [subscribed, argsKey]);
  const results = useQueries(queries) as Record<string, unknown>;
  const raw = subscribed ? results.policy : undefined;
  const lastIdentityRef = useRef<{
    key: string;
    identity: TelemetryIdentity;
  } | null>(null);

  if (!subscribed || actorKey === undefined) {
    return { policy: undefined, identity: undefined, actor: null };
  }
  const actor = actorKey === ANONYMOUS_TELEMETRY_ACTOR ? null : actorKey;
  if (raw === undefined) {
    const last = lastIdentityRef.current;
    return {
      policy: undefined,
      identity: last?.key === subscriptionKey ? last.identity : undefined,
      actor,
    };
  }
  const policy =
    raw instanceof Error || !isTelemetryPolicy(raw)
      ? { ...CONSERVATIVE_TELEMETRY_POLICY }
      : { recording: raw.recording, identity: raw.identity };
  lastIdentityRef.current = { key: subscriptionKey, identity: policy.identity };
  return { policy, identity: policy.identity, actor };
}
