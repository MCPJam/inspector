import { toast } from "@/lib/toast";
import posthog from "posthog-js";
import type { ConvexReactClient } from "convex/react";
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
import type { HostAttachmentDraft } from "@/components/evals/client-attachments-editor";

export const EXCALIDRAW_QUICKSTART_SUITE_NAME = "Excalidraw quickstart";

type CreateSuiteArgs = {
  projectId: string;
  name: string;
  description?: string;
  environment: { servers: string[] };
  tags?: string[];
  serverAttachmentId?: string;
  hostAttachments?: HostAttachmentDraft[];
};

type CreateSuiteResult = { _id: string } | null | undefined;

type CreateServerAttachmentArgs = {
  projectId: string;
  name: string;
  serverIds: string[];
};

type ServerAttachmentRow = {
  _id: string;
  name: string;
  serverIds: string[];
  resolvedServerNames: string[];
};

type ProjectServerRow = {
  _id: string;
  name: string;
};

type HostListRow = {
  hostId: string;
};

export type RunExcalidrawQuickstartOptions = {
  projectId: string;
  convex: ConvexReactClient;
  createTestSuite: (args: CreateSuiteArgs) => Promise<CreateSuiteResult>;
  createTestCase: (input: CreateEvalTestCaseInput) => Promise<unknown>;
  createServerAttachment: (
    args: CreateServerAttachmentArgs,
  ) => Promise<{ _id: string }>;
  handleConnect: (config: ServerFormData) => void | Promise<void>;
  /** True when the project already has Excalidraw attached + connected. */
  isExcalidrawConnected: boolean;
  /**
   * Existing quickstart suite for this project, if any. When present, the
   * quickstart is idempotent — we navigate to it instead of minting another.
   */
  existingQuickstartSuiteId: string | null;
  /**
   * Currently previewed host (from the overlay bar). Used as the preferred
   * default client attachment so the quickstart suite matches whatever the
   * user is already working with, instead of just `hosts[0]`.
   */
  previewedHostId: string | null;
};

const SERVER_WAIT_TIMEOUT_MS = 15_000;
const SERVER_WAIT_INTERVAL_MS = 350;

async function waitForExcalidrawServerId(
  convex: ConvexReactClient,
  projectId: string,
): Promise<string | null> {
  const deadline = Date.now() + SERVER_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const servers = (await convex.query(
      "servers:getProjectServers" as any,
      { projectId } as any,
    )) as ProjectServerRow[] | undefined;
    const match = servers?.find((s) => s.name === EXCALIDRAW_SERVER_NAME);
    if (match) return match._id;
    await new Promise((resolve) =>
      setTimeout(resolve, SERVER_WAIT_INTERVAL_MS),
    );
  }
  return null;
}

const QUICKSTART_ATTACHMENT_BASE_NAME = "Excalidraw";

async function resolveServerAttachmentId(
  convex: ConvexReactClient,
  createServerAttachment: (
    args: CreateServerAttachmentArgs,
  ) => Promise<{ _id: string }>,
  projectId: string,
  excalidrawServerId: string,
): Promise<string> {
  const existing = (await convex.query(
    "serverAttachments:listServerAttachments" as any,
    { projectId } as any,
  )) as ServerAttachmentRow[] | undefined;
  const rows = existing ?? [];

  // Prefer an exact single-server match; that's the cleanest reuse.
  const exact = rows.find(
    (row) =>
      row.serverIds.length === 1 && row.serverIds[0] === excalidrawServerId,
  );
  if (exact) return exact._id;

  // Next-best: an attachment that at least includes our server id — the
  // quickstart cases only call Excalidraw tools, so extra servers in the
  // pool don't break the run.
  const superset = rows.find((row) =>
    row.serverIds.includes(excalidrawServerId),
  );
  if (superset) return superset._id;

  // Backend rejects duplicate names within a project, so suffix until we
  // find a free one. The base name is the common case; the loop only
  // engages when a user has manually created an "Excalidraw" attachment
  // that doesn't include the quickstart server.
  const usedNames = new Set(rows.map((row) => row.name));
  let name = QUICKSTART_ATTACHMENT_BASE_NAME;
  for (let suffix = 2; usedNames.has(name); suffix += 1) {
    name = `${QUICKSTART_ATTACHMENT_BASE_NAME} ${suffix}`;
  }

  const created = await createServerAttachment({
    projectId,
    name,
    serverIds: [excalidrawServerId],
  });
  return created._id;
}

async function resolvePreferredHostAttachment(
  convex: ConvexReactClient,
  projectId: string,
  preferredHostId: string | null,
): Promise<HostAttachmentDraft[]> {
  const hosts = (await convex.query(
    "hosts:listHosts" as any,
    { projectId } as any,
  )) as HostListRow[] | undefined;
  const preferred =
    (preferredHostId
      ? hosts?.find((h) => h.hostId === preferredHostId)
      : undefined) ?? hosts?.[0];
  if (!preferred) return [];
  return [{ namedHostId: preferred.hostId, enabledOptionalServerIds: [] }];
}

export async function runExcalidrawQuickstart(
  options: RunExcalidrawQuickstartOptions,
): Promise<void> {
  const {
    projectId,
    convex,
    createTestSuite,
    createTestCase,
    createServerAttachment,
    handleConnect,
    isExcalidrawConnected,
    existingQuickstartSuiteId,
    previewedHostId,
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
    await Promise.resolve(handleConnect(EXCALIDRAW_SERVER_CONFIG));
  }

  // The Convex projectServers row lags the local connect dispatch; without
  // an id we can't build a server attachment, so the chip would render
  // "pick one" on the new suite. Poll until the row materializes.
  const excalidrawServerId = await waitForExcalidrawServerId(
    convex,
    projectId,
  );
  if (!excalidrawServerId) {
    toast.error(
      "Could not connect to the Excalidraw server in time. Try again in a moment.",
    );
    return;
  }

  let serverAttachmentId: string;
  try {
    serverAttachmentId = await resolveServerAttachmentId(
      convex,
      createServerAttachment,
      projectId,
      excalidrawServerId,
    );
  } catch (error) {
    console.error("Excalidraw quickstart: server attachment failed", error);
    toast.error("Could not prepare the Excalidraw quickstart. Try again.");
    return;
  }

  const hostAttachments = await resolvePreferredHostAttachment(
    convex,
    projectId,
    previewedHostId,
  );

  let createdSuiteId: string | null = null;
  try {
    const created = await createTestSuite({
      projectId,
      name: EXCALIDRAW_QUICKSTART_SUITE_NAME,
      description: "Curated cases for the Excalidraw MCP server.",
      environment: { servers: [EXCALIDRAW_SERVER_NAME] },
      tags: [QUICKSTART_SUITE_TAG],
      serverAttachmentId,
      ...(hostAttachments.length > 0 ? { hostAttachments } : {}),
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
    has_host_attachment: hostAttachments.length > 0,
  });

  if (createdCases < EXCALIDRAW_QUICKSTART_CASES.length) {
    toast.warning(
      `Created ${createdCases} of ${EXCALIDRAW_QUICKSTART_CASES.length} cases. The suite is ready — you can fill in the rest manually.`,
    );
  } else if (hostAttachments.length === 0) {
    toast.success(
      "Excalidraw quickstart ready. Attach a client to run it.",
    );
  } else {
    toast.success("Excalidraw quickstart ready. Connect, then run.");
  }

  navigatePlaygroundEvalsRoute({
    type: "suite-overview",
    suiteId: createdSuiteId,
  });
}
