import { useMemo } from "react";
import { useConvexAuth, useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { orgRequiresOwnKeys } from "@/shared/org-ai-key-policy";
import { orgKeyHarnessName } from "@/shared/org-key-surfaces";

/** Whether the organization's key for a harness (Cursor) can run it now. */
export type OrgHarnessKeyReadiness = "ready" | "missing" | "invalid";

/** Each harness's readiness; a harness is absent until its answer is read. */
export type OrgHarnessKeys = Readonly<
  Partial<Record<string, OrgHarnessKeyReadiness>>
>;

const readinessForProject = makeFunctionReference<
  "query",
  { projectId: string; harnessId: string },
  { readiness?: unknown } | null
>("organizationHarnessCredentials:getReadinessForProject");

function readinessOf(answer: unknown): OrgHarnessKeyReadiness | undefined {
  if (!answer || typeof answer !== "object" || !("readiness" in answer)) {
    return undefined;
  }
  const { readiness } = answer;
  return readiness === "ready" ||
    readiness === "missing" ||
    readiness === "invalid"
    ? readiness
    : undefined;
}

/**
 * The organization's key readiness for each harness the project's clients run
 * on such a key (Cursor), as the launch checks it. Read only while the
 * organization requires its own keys, the one time the run sheet judges it.
 * An answer that can't be read (someone outside the project, an older
 * backend) leaves its harness absent, and the launch decides.
 */
export function useOrgHarnessKeys(
  projectId: string,
  orgConfig: { readonly aiKeyPolicy?: unknown } | null | undefined,
  hosts: readonly { harness?: string | null }[],
): OrgHarnessKeys {
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const asks =
    isAuthenticated &&
    isUserReady &&
    shouldQueryProjectId(projectId) &&
    orgRequiresOwnKeys(orgConfig);
  // Convex resubscribes whenever the queries object changes identity.
  const key = asks
    ? [
        ...new Set(
          hosts.flatMap((host) =>
            host.harness && orgKeyHarnessName(host.harness)
              ? [host.harness]
              : [],
          ),
        ),
      ]
        .sort()
        .join(",")
    : "";
  const queries = useMemo(
    () =>
      Object.fromEntries(
        (key ? key.split(",") : []).map((harnessId) => [
          harnessId,
          { query: readinessForProject, args: { projectId, harnessId } },
        ]),
      ),
    [projectId, key],
  );
  const answers = useQueries(queries);
  return useMemo(() => {
    const keys: Partial<Record<string, OrgHarnessKeyReadiness>> = {};
    for (const [harnessId, answer] of Object.entries(answers)) {
      if (answer instanceof Error) {
        console.warn(
          "[Setup Run] Could not read the organization's harness key; the launch will check it.",
          answer,
        );
        continue;
      }
      const readiness = readinessOf(answer);
      if (readiness) keys[harnessId] = readiness;
    }
    return keys;
  }, [answers]);
}
