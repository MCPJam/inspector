import { useMemo } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { useActorCanQuery } from "@/hooks/use-actor-can-query";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import {
  useProjectServers,
  useProjectServerAttachments,
} from "@/hooks/useViews";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { disambiguateLabels, environmentLabel } from "@/lib/environment-label";
import { buildHostNamesById } from "../helpers";
import type { StageFactsTarget } from "../suite-stage-facts-panel";
import type { EvalSuite } from "../types";

/** What each run target connects to, for the connection and discovery facts. */
export function useStageFactTargets(
  suite: EvalSuite,
  projectId: string | null,
) {
  const { isAuthenticated } = useConvexAuth();
  const projectEnvironments = useProjectEnvironments(projectId, {
    includeAdhoc: true,
  });
  const { hosts: namableHosts } = useHostList({
    isAuthenticated,
    projectId,
    includePrivateBacking: true,
  });
  const hostNamesById = useMemo(
    () => buildHostNamesById(suite.hostAttachments, namableHosts),
    [suite.hostAttachments, namableHosts],
  );
  // The suite's OWN host config — what an attachment-less suite runs under.
  const canQuerySuiteHostConfig = useActorCanQuery();
  const suiteOwnHostConfig = useQuery(
    "hostConfigsV2:getSuiteConfig" as never,
    canQuerySuiteHostConfig && suite._id
      ? ({ suiteId: suite._id } as never)
      : "skip",
  ) as HostConfigDtoV2 | null | undefined;

  const { servers: factsProjectServers } = useProjectServers({
    isAuthenticated,
    projectId: projectId ?? null,
  });
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId: projectId ?? null,
  });

  /**
   * The same two modes the environments row renders: attached environments when
   * this deployment composes cells, else the legacy host attachments. A target
   * that names a server GROUP knows its ids here; one that uses the client's
   * own servers cannot know them until the host config loads, so the panel
   * finishes that half.
   */
  const stageFactTargets = useMemo<StageFactsTarget[]>(() => {
    const attachmentById = new Map(
      (serverAttachments ?? []).map((row) => [row._id, row]),
    );
    // NOT gated on `composeCapable`: that capability decides whether this
    // deployment can EDIT client x model cells, not what a run fans out over.
    // A suite with attached environments runs one per environment either way —
    // `summarizeEnvironments` reads them the same way — so gating here reported
    // "no run target" for a suite that has several.
    if ((suite.environmentIds?.length ?? 0) > 0) {
      const rows = (suite.environmentIds ?? []).map((environmentId) => {
        const environment = projectEnvironments?.find(
          (row) => row.environmentId === environmentId,
        );
        return { environmentId, environment };
      });
      const labeled = disambiguateLabels(
        rows.map(({ environmentId, environment }) => ({
          environmentId,
          label: environment
            ? environmentLabel(environment, {
                hostName: (id) => hostNamesById.get(id) ?? undefined,
              })
            : environmentId,
        })),
      );
      return rows.map(({ environmentId, environment }, index) => {
        const attachment = environment?.serverAttachmentId
          ? attachmentById.get(environment.serverAttachmentId)
          : undefined;
        return {
          key: environmentId,
          label: labeled[index].label,
          hostId: environment?.hostId ?? "",
          environmentId,
          attachment: attachment
            ? { id: attachment._id, name: attachment.name }
            : null,
          servers: attachment
            ? { kind: "attachment" as const, ids: attachment.serverIds }
            : { kind: "host" as const, extraIds: [] },
        };
      });
    }
    // Legacy: a suite-level server attachment replaces every host's own picks
    // (see `EvalSuite.serverAttachmentId`), so it wins for all of them.
    const suiteAttachment = suite.serverAttachmentId
      ? attachmentById.get(suite.serverAttachmentId)
      : undefined;
    if ((suite.hostAttachments ?? []).length === 0) {
      // No environment and no attached client is still a RUN TARGET: the suite
      // executes under its own saved host config, falling back to the default
      // MCPJam client when it never wrote one (`loadSuiteHostConfig`). Saying
      // "no run target yet" here sent a reader to attach something the run does
      // not need. No `hostId`, because this config belongs to the suite rather
      // than to a client row there would be a page for.
      return suiteOwnHostConfig
        ? [
            {
              key: "suite-host",
              label: "This suite's own client",
              hostId: "",
              hostConfig: suiteOwnHostConfig,
              attachment: null,
              servers: { kind: "host" as const, extraIds: [] },
            },
          ]
        : [];
    }
    return (suite.hostAttachments ?? []).map((attachmentRow) => ({
      key: attachmentRow.namedHostId,
      label:
        hostNamesById.get(attachmentRow.namedHostId) ??
        attachmentRow.hostName ??
        attachmentRow.namedHostId,
      hostId: attachmentRow.namedHostId,
      attachment: suiteAttachment
        ? { id: suiteAttachment._id, name: suiteAttachment.name }
        : null,
      servers: suiteAttachment
        ? { kind: "attachment" as const, ids: suiteAttachment.serverIds }
        : {
            kind: "host" as const,
            extraIds: attachmentRow.enabledOptionalServerIds ?? [],
          },
    }));
  }, [
    suiteOwnHostConfig,
    suite.environmentIds,
    suite.hostAttachments,
    suite.serverAttachmentId,
    projectEnvironments,
    serverAttachments,
    hostNamesById,
  ]);

  return { stageFactTargets, factsProjectServers, isAuthenticated };
}
