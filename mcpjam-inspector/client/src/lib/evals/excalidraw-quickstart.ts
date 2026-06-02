import { toast } from "sonner";
import posthog from "posthog-js";
import {
  EXCALIDRAW_SERVER_CONFIG,
  EXCALIDRAW_SERVER_NAME,
} from "@/lib/excalidraw-quick-connect";
import { QUICKSTART_SUITE_TAG } from "@/components/evals/constants";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { navigatePlaygroundEvalsRoute } from "@/components/evals/create-suite-navigation";
import { EXCALIDRAW_QUICKSTART_CASES } from "./excalidraw-quickstart-cases";
import type { ServerFormData } from "@/shared/types.js";
import type { CreateEvalTestCaseInput } from "./generate-and-persist-tests";

export const EXCALIDRAW_QUICKSTART_SUITE_NAME = "Excalidraw quickstart";

type CreateSuiteArgs = {
  projectId: string;
  name: string;
  description?: string;
  environment: { servers: string[] };
  tags?: string[];
};

type CreateSuiteResult = { _id: string } | null | undefined;

export type RunExcalidrawQuickstartOptions = {
  projectId: string;
  createTestSuite: (args: CreateSuiteArgs) => Promise<CreateSuiteResult>;
  createTestCase: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  handleConnect: (config: ServerFormData) => void;
  /** True when the project already has Excalidraw attached + connected. */
  isExcalidrawConnected: boolean;
  /**
   * Existing quickstart suite for this project, if any. When present, the
   * quickstart is idempotent — we navigate to it instead of minting another.
   */
  existingQuickstartSuiteId: string | null;
};

export async function runExcalidrawQuickstart(
  options: RunExcalidrawQuickstartOptions,
): Promise<void> {
  const {
    projectId,
    createTestSuite,
    createTestCase,
    handleConnect,
    isExcalidrawConnected,
    existingQuickstartSuiteId,
  } = options;

  posthog.capture("eval_excalidraw_quickstart_clicked", {
    location: "playground_tab_empty",
    platform: detectPlatform(),
    environment: detectEnvironment(),
    project_id: projectId,
    already_connected: isExcalidrawConnected,
    existing_suite: existingQuickstartSuiteId !== null,
  });

  if (existingQuickstartSuiteId) {
    navigatePlaygroundEvalsRoute({
      type: "suite-overview",
      suiteId: existingQuickstartSuiteId,
    });
    return;
  }

  if (!isExcalidrawConnected) {
    handleConnect(EXCALIDRAW_SERVER_CONFIG);
  }

  let createdSuiteId: string | null = null;
  try {
    const created = await createTestSuite({
      projectId,
      name: EXCALIDRAW_QUICKSTART_SUITE_NAME,
      description: "Curated cases for the Excalidraw MCP server.",
      environment: { servers: [EXCALIDRAW_SERVER_NAME] },
      tags: [QUICKSTART_SUITE_TAG],
    });
    createdSuiteId = created?._id ?? null;
  } catch (error) {
    console.error("Excalidraw quickstart: create suite failed", error);
    toast.error("Could not create the Excalidraw quickstart. Try again.");
    return;
  }

  if (!createdSuiteId) {
    toast.error("Could not create the Excalidraw quickstart. Try again.");
    return;
  }

  let createdCases = 0;
  for (const caseDraft of EXCALIDRAW_QUICKSTART_CASES) {
    try {
      await createTestCase({ ...caseDraft, suiteId: createdSuiteId });
      createdCases += 1;
    } catch (error) {
      console.error("Excalidraw quickstart: create case failed", error);
    }
  }

  posthog.capture("eval_excalidraw_quickstart_completed", {
    location: "playground_tab_empty",
    platform: detectPlatform(),
    environment: detectEnvironment(),
    project_id: projectId,
    suite_id: createdSuiteId,
    cases_created: createdCases,
    cases_intended: EXCALIDRAW_QUICKSTART_CASES.length,
  });

  if (createdCases < EXCALIDRAW_QUICKSTART_CASES.length) {
    toast.warning(
      `Created ${createdCases} of ${EXCALIDRAW_QUICKSTART_CASES.length} cases. The suite is ready — you can fill in the rest manually.`,
    );
  } else {
    toast.success("Excalidraw quickstart ready. Connect, then run.");
  }

  navigatePlaygroundEvalsRoute({
    type: "suite-overview",
    suiteId: createdSuiteId,
  });
}
