import { useEffect, useRef, useState } from "react";
import { checkHostedServerOAuthRequirement } from "@/lib/apis/web/servers-api";

/**
 * "checking" is the pre-answer state and is deliberately NOT gated as
 * required: the bootstrap payload's `useOAuth` is a compat mirror that is also
 * true for `auto` (discover) servers, so treating an unanswered probe as
 * "requires authorization" is exactly the bug — a no-auth server asking a
 * recipient for consent it cannot give. Gating only on a positive answer costs
 * an OAuth-backed scenario a moment of usable composer before its card
 * appears; guessing the other way dead-ends the no-auth ones.
 */
export type HostedOAuthRequirement = "checking" | "required" | "not_required";

const PROBE_ATTEMPTS = 6;
const PROBE_RETRY_DELAY_MS = 300;

export interface HostedOAuthRequirementInput {
  serverId: string;
  useOAuth: boolean;
}

/**
 * Asks the inspector server, per server, whether the recipient must authorize
 * before the scenario can run — `/api/web/servers/check-oauth`'s
 * `requiresAuthorization`, which resolves the canonical `authMethod` instead of
 * the derived `useOAuth` mirror the bootstrap payload carries.
 *
 * Only `useOAuth` rows are probed: a row the mirror already says can never use
 * OAuth cannot require it either, and the probe costs an authorize round trip.
 *
 * A failed probe resolves to "not_required" rather than staying pending — a
 * server we could not classify must not hold the composer hostage, and a
 * server that genuinely wants authorization still escalates at runtime through
 * the tagged 401 (`onOAuthRequired` → `markOAuthRequired`).
 */
export function useHostedOAuthRequirements(
  servers: HostedOAuthRequirementInput[],
  enabled: boolean
): Record<string, HostedOAuthRequirement> {
  const [requirementByServerId, setRequirementByServerId] = useState<
    Record<string, HostedOAuthRequirement>
  >({});
  const probedServerIdsRef = useRef<Set<string>>(new Set());
  const isUnmountedRef = useRef(false);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;

    for (const server of servers) {
      if (!server.useOAuth) continue;
      if (probedServerIdsRef.current.has(server.serverId)) continue;
      probedServerIdsRef.current.add(server.serverId);

      setRequirementByServerId((previous) =>
        previous[server.serverId]
          ? previous
          : { ...previous, [server.serverId]: "checking" }
      );

      void (async () => {
        let requirement: HostedOAuthRequirement = "not_required";
        for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
          try {
            const response = await checkHostedServerOAuthRequirement(
              server.serverId
            );
            // An inspector server that predates `requiresAuthorization` can
            // only offer the mirror, so fall back to it rather than silently
            // deciding that nothing ever needs authorizing.
            requirement =
              response.requiresAuthorization ?? response.useOAuth
                ? "required"
                : "not_required";
            break;
          } catch (error) {
            // The first attempts routinely lose a race with bootstrap: the
            // request builder throws BootstrapNotReadyError until the API
            // context carries this chatbox's project and server ids. Retrying
            // is what keeps a real OAuth server from being classified as
            // no-auth purely because the probe fired one tick too early.
            if (attempt === PROBE_ATTEMPTS - 1) {
              console.error(
                "[useHostedOAuthRequirements] could not resolve authorization requirement",
                { serverId: server.serverId, error }
              );
              break;
            }
            await new Promise((resolve) =>
              setTimeout(resolve, PROBE_RETRY_DELAY_MS)
            );
            if (isUnmountedRef.current) return;
          }
        }
        if (isUnmountedRef.current) return;
        setRequirementByServerId((previous) => ({
          ...previous,
          [server.serverId]: requirement,
        }));
      })();
    }
  }, [enabled, servers]);

  return requirementByServerId;
}
