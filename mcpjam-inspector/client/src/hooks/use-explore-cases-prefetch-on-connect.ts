import { useEffect, useRef } from "react";
import {
  useConvex,
  useConvexAuth,
  useMutation,
  useQuery,
} from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import { toast } from "sonner";
import posthog from "posthog-js";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { EvalSuite, EvalSuiteOverviewEntry } from "@/components/evals/types";
import { generateAndPersistEvalTests } from "@/lib/evals/generate-and-persist-tests";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";

const EXPLORE_TAG = "explore";

function isExploreSuite(suite: EvalSuite): boolean {
  return suite.tags?.includes(EXPLORE_TAG) === true;
}

function findExploreSuiteEntry(
  overview: EvalSuiteOverviewEntry[] | undefined,
  serverName: string,
): EvalSuiteOverviewEntry | null {
  if (!overview) return null;
  const manual = overview.filter((entry) => entry.suite.source !== "sdk");
  return (
    manual.find(
      (entry) =>
        isExploreSuite(entry.suite) &&
        entry.suite.environment?.servers?.[0] === serverName,
    ) ?? null
  );
}

/**
 * When a workspace server transitions to MCP "connected", ensure an Explore suite
 * exists and prefetch AI-generated test cases if the suite has none yet.
 * Does not start a suite run.
 */
export function useExploreCasesPrefetchOnConnect(
  workspaceId: string | null | undefined,
  server: ServerWithName,
) {
  const { isAuthenticated } = useConvexAuth();
  const { user, getAccessToken } = useAuth();
  const convex = useConvex();
  const createTestSuiteMutation = useMutation(
    "testSuites:createTestSuite" as any,
  );
  const updateTestSuiteMutation = useMutation(
    "testSuites:updateTestSuite" as any,
  );
  const createTestCaseMutation = useMutation(
    "testSuites:createTestCase" as any,
  );

  const suiteOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    isAuthenticated && user && workspaceId
      ? ({ workspaceId } as any)
      : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const prevStatusRef = useRef(server.connectionStatus);
  const pendingExplorePrefetchRef = useRef(false);
  const inFlightRef = useRef(new Set<string>());

  useEffect(() => {
    const prev = prevStatusRef.current;
    const status = server.connectionStatus;
    prevStatusRef.current = status;

    if (status === "connected" && prev !== "connected") {
      pendingExplorePrefetchRef.current = true;
    }

    if (status !== "connected") {
      pendingExplorePrefetchRef.current = false;
      return;
    }

    if (!workspaceId || !isAuthenticated || !user) {
      return;
    }

    if (!pendingExplorePrefetchRef.current) {
      return;
    }

    if (suiteOverview === undefined) {
      return;
    }

    pendingExplorePrefetchRef.current = false;

    const serverName = server.name;
    const inFlightKey = `${workspaceId}::${serverName}`;
    if (inFlightRef.current.has(inFlightKey)) {
      return;
    }

    inFlightRef.current.add(inFlightKey);

    void (async () => {
      try {
        const freshOverview = (await convex.query(
          "testSuites:getTestSuitesOverview" as any,
          { workspaceId } as any,
        )) as EvalSuiteOverviewEntry[] | undefined;

        let exploreEntry = findExploreSuiteEntry(freshOverview, serverName);
        let suiteId = exploreEntry?.suite._id;

        if (!suiteId) {
          const createdSuite = await createTestSuiteMutation({
            workspaceId,
            name: serverName,
            description: `Explore cases for ${serverName}`,
            environment: { servers: [serverName] },
          });
          if (createdSuite?._id) {
            await updateTestSuiteMutation({
              suiteId: createdSuite._id,
              tags: [EXPLORE_TAG],
            });
            suiteId = createdSuite._id;
          }
        }

        if (!suiteId) {
          return;
        }

        const outcome = await generateAndPersistEvalTests({
          convex,
          getAccessToken,
          workspaceId,
          suiteId,
          serverIds: [serverName],
          createTestCase: createTestCaseMutation,
          skipIfExistingCases: true,
        });

        if (outcome.skippedBecauseExistingCases) {
          return;
        }

        if (outcome.createdCount > 0) {
          posthog.capture("eval_explore_cases_prefetched_on_connect", {
            location: "server_connection_card",
            platform: detectPlatform(),
            environment: detectEnvironment(),
            workspace_id: workspaceId,
            server_id: serverName,
            suite_id: suiteId,
            generated_count: outcome.createdCount,
          });
        }
      } catch (error) {
        console.error("Explore cases prefetch failed:", error);
        toast.error(
          getBillingErrorMessage(
            error,
            "Failed to prepare explore test cases for this server",
          ),
        );
      } finally {
        inFlightRef.current.delete(inFlightKey);
      }
    })();
  }, [
    convex,
    createTestCaseMutation,
    createTestSuiteMutation,
    getAccessToken,
    isAuthenticated,
    server.connectionStatus,
    server.name,
    suiteOverview,
    updateTestSuiteMutation,
    user,
    workspaceId,
  ]);
}
