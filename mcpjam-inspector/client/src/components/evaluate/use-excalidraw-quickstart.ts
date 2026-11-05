import { useCallback, useMemo, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "@/lib/toast";
import { useEnvironmentCapabilities } from "@/hooks/use-environment-capabilities";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { EXCALIDRAW_SERVER_NAME } from "@/lib/excalidraw-quick-connect";
import {
  EXCALIDRAW_QUICKSTART_SUITE_NAME,
  runExcalidrawQuickstart,
} from "@/lib/evals/excalidraw-quickstart";
import type { ServerFormData } from "@/shared/types.js";
import { isQuickstartSuite } from "../evals/constants";
import type { EvalSuiteOverviewEntry } from "../evals/types";
import type { useEvalMutations } from "../evals/use-eval-mutations";
import { navigatePlaygroundEvalsRoute } from "./create-suite-navigation";

const createServerAttachmentMutation = makeFunctionReference<
  "mutation",
  { projectId: string; name: string; serverIds: string[] },
  { _id: string }
>("serverAttachments:createServerAttachment");

/**
 * The empty state's sample suite: connects Excalidraw, creates (or reuses)
 * the quickstart suite and opens it in Evaluate. Unavailable without
 * `handleConnect`, which only the app shell provides.
 */
export function useExcalidrawQuickstart({
  projectId,
  handleConnect,
  suites,
  connectedServerNames,
  mutations,
}: {
  projectId: string | null | undefined;
  handleConnect?: (config: ServerFormData) => void;
  suites: readonly EvalSuiteOverviewEntry[];
  connectedServerNames: ReadonlySet<string>;
  mutations: Pick<
    ReturnType<typeof useEvalMutations>,
    "createTestSuiteMutation" | "createTestCaseMutation"
  >;
}) {
  const convex = useConvex();
  const [previewedHostId] = usePreviewedHostId(projectId ?? null);
  const environmentCapabilities = useEnvironmentCapabilities(projectId);
  const createServerAttachment = useMutation(createServerAttachmentMutation);
  const [isRunning, setIsRunning] = useState(false);

  const existingQuickstartSuiteId = useMemo(() => {
    const match = suites.find(
      (entry) =>
        isQuickstartSuite(entry.suite) ||
        entry.suite.name === EXCALIDRAW_QUICKSTART_SUITE_NAME,
    );
    return match?.suite._id ?? null;
  }, [suites]);

  const run = useCallback(async () => {
    if (!handleConnect || isRunning) return;
    if (!projectId) {
      toast.error("Select or create a project before running the quickstart.");
      return;
    }
    setIsRunning(true);
    try {
      await runExcalidrawQuickstart({
        projectId,
        convex,
        createTestSuite: mutations.createTestSuiteMutation,
        createTestCase: mutations.createTestCaseMutation,
        createServerAttachment,
        handleConnect,
        isExcalidrawConnected: connectedServerNames.has(EXCALIDRAW_SERVER_NAME),
        existingQuickstartSuiteId,
        previewedHostId,
        environmentSuites:
          environmentCapabilities?.createSuiteWithEnvironments === true,
        // Stay in Evaluate. The default lands on `/evals/...`, which dropped
        // the reader into the shipped tab's copy of the suite they just made.
        navigate: navigatePlaygroundEvalsRoute,
      });
    } finally {
      setIsRunning(false);
    }
  }, [
    projectId,
    convex,
    handleConnect,
    isRunning,
    mutations.createTestSuiteMutation,
    mutations.createTestCaseMutation,
    createServerAttachment,
    connectedServerNames,
    existingQuickstartSuiteId,
    previewedHostId,
    environmentCapabilities,
  ]);

  return { run, isRunning, available: Boolean(handleConnect) };
}
