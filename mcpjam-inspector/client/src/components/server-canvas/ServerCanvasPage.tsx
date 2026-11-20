import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  FEATURE_CARD_NAMES,
  SERVER_FEATURE_CATALOG,
  type FeatureNextAction,
} from "@mcpjam/sdk/browser";
import { Button } from "@mcpjam/design-system/button";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  useServerDetailController,
  type ServerDetailControllerOptions,
} from "@/components/connection/hooks/use-server-detail-controller";
import {
  ServerDetailConnectionControls,
  ServerDetailIdentity,
} from "@/components/connection/ServerDetailTabBodies";
import {
  buildConformanceRunPath,
  buildConformanceRunServerPath,
  routePaths,
  useAppNavigate,
} from "@/lib/app-navigation";
import {
  clearOpenServerDetailModalState,
  clearServerDetailModalOAuthResume,
  readServerDetailModalOAuthResume,
  writeOpenServerDetailModalState,
} from "@/lib/server-detail-modal-resume";
import { CaptureBanner, describeCaptureContext, type CaptureStatus } from "./CaptureBanner";
import { FeatureDetail } from "./FeatureDetail";
import { ServerCanvasSidePanel } from "./ServerCanvasSidePanel";
import { ServerFeatureMap } from "./ServerFeatureMap";
import { formatEvidenceTime } from "./feature-states";
import { buildFeatureCards, resolveFeatureSelection } from "./feature-tree";
import { overviewCapabilities } from "./overview-capabilities";
import { useServerCanvasRefresh } from "./server-canvas-refresh";
import { useServerCanvasUrlState } from "./server-canvas-url";
import { useServerFeatureEvidence } from "./use-server-feature-evidence";
import {
  CANVAS_CHECK_SUITES,
  CANVAS_SETUP_OFFERED,
  configuredSetup,
} from "./setup-state";

export interface ServerCanvasPageProps
  extends Omit<
    ServerDetailControllerOptions,
    | "isOpen"
    | "defaultTab"
    | "activeTab"
    | "onTabChange"
    | "analyticsLocation"
    | "onClose"
    | "projectId"
    | "hostedServerId"
  > {
  projectId: string;
  /** The project server's Convex id, as in `/servers/:serverId`. */
  hostedServerId: string;
  projectXaaDefaultIdentity?: { subject: string; email: string } | null;
  onBack: () => void;
}

/**
 * Marks the details open for the OAuth redirect, as the modal does, and
 * drops the resume marker the redirect leaves: the return path already
 * brought the reader back to this page and its tab.
 */
function useOAuthResumeMarker(serverName: string) {
  useEffect(() => {
    writeOpenServerDetailModalState(serverName);
    if (readServerDetailModalOAuthResume()?.serverName === serverName)
      clearServerDetailModalOAuthResume();
    return () => clearOpenServerDetailModalState();
  }, [serverName]);
}

/**
 * `/servers/:serverId` for a project server with the server canvas on: the
 * feature map on the left, the modal's tabs on the right, the selected
 * feature's detail above the active tab. Opening it reads saved evidence
 * only; Refresh and Run checks are the reader's to start.
 */
export function ServerCanvasPage({
  projectId,
  hostedServerId,
  projectXaaDefaultIdentity = null,
  onBack,
  ...options
}: ServerCanvasPageProps) {
  const url = useServerCanvasUrlState();
  const navigate = useAppNavigate();
  const controller = useServerDetailController({
    ...options,
    isOpen: true,
    projectId,
    hostedServerId,
    activeTab: url.tab,
    onTabChange: url.setTab,
    analyticsLocation: "server_canvas",
    onClose: onBack,
  });
  const { server, connection } = controller;
  useOAuthResumeMarker(server.name);

  const [contextHash, setContextHash] = useState<string | undefined>();
  const { registrationMode, oauthFlowProfile, useXaa, authMethod } = server;
  const configured = useMemo(
    () =>
      configuredSetup({ registrationMode, oauthFlowProfile, useXaa, authMethod }),
    [registrationMode, oauthFlowProfile, useXaa, authMethod],
  );
  const evidence = useServerFeatureEvidence(projectId, hostedServerId, {
    connected: connection.isConnected,
    contextHash,
    configured,
    setupOffered: CANVAS_SETUP_OFFERED,
    checksOffered: CANVAS_CHECK_SUITES,
  });
  const { selected, evaluation } = evidence;
  const refresh = useServerCanvasRefresh({
    projectId,
    serverId: hostedServerId,
    evidenceStamp: evidence.stamp,
    latestAttempt: selected.latestAttempt,
  });

  const cards = useMemo(
    () => buildFeatureCards(SERVER_FEATURE_CATALOG, evaluation),
    [evaluation],
  );
  const selection = useMemo(
    () => resolveFeatureSelection(url.featureId, SERVER_FEATURE_CATALOG),
    [url.featureId],
  );
  const capabilities = useMemo(
    () => overviewCapabilities({ status: evidence.status, selected, evaluation }),
    [evidence.status, selected, evaluation],
  );

  const runChecks = useCallback(
    () => navigate(buildConformanceRunServerPath(server.name)),
    [navigate, server.name],
  );
  const openRun = useCallback(
    (runId: string) => navigate(buildConformanceRunPath(runId, projectId)),
    [navigate, projectId],
  );
  const connect = useCallback(() => {
    if (connection.isConnected)
      void connection.connect({ allowInteractiveOAuthFlow: false });
    else connection.toggle(true);
  }, [connection]);
  const onAction = (action: FeatureNextAction) => {
    if (action === "connect" || action === "reconnect") connect();
    else if (action === "run-checks") runChecks();
    else if (action === "use-in-playground") navigate(routePaths.playground);
    else if (action === "refresh") refresh.refresh();
    else {
      url.setTab("configuration");
      // The protocol version override sits in the collapsed advanced settings.
      if (action === "upgrade-version") controller.form.state.setShowConfiguration(true);
    }
  };

  const context = selected.input.context;
  const surface = selected.input.declared?.surface;
  const declaredVersion = surface?.serverInfo?.version;
  const protocolVersion =
    context?.protocolVersion ??
    surface?.protocolVersion ??
    server.initializationInfo?.protocolVersion;
  const hasEvidence =
    selected.contexts.length > 0 || selected.capturedAt !== undefined;
  const status: CaptureStatus = connection.isConnected
    ? "connected"
    : hasEvidence || server.initializationInfo
      ? "disconnected"
      : "never";
  const subtitleText = [
    context ? describeCaptureContext(context) : protocolVersion,
    selected.capturedAt
      ? `captured ${formatEvidenceTime(selected.capturedAt)}`
      : "not captured yet",
  ]
    .filter(Boolean)
    .join(" · ");
  const subtitle = subtitleText.charAt(0).toUpperCase() + subtitleText.slice(1);

  const familyId = selection?.family.id;
  const detail = selection ? (
    <FeatureDetail
      selection={selection}
      assessment={
        selection.kind === "feature"
          ? evaluation.assessments[selection.feature.id]
          : undefined
      }
      familyModel={cards
        .flatMap((card) => card.families)
        .find((family) => family.family.id === familyId)}
      cardName={FEATURE_CARD_NAMES[selection.family.card]}
      onClose={() => url.setFeature(null)}
      onSelect={url.setFeature}
      onAction={onAction}
      onOpenRun={openRun}
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="server-canvas-page">
      <header className="flex flex-wrap items-center gap-3 px-6 pb-2 pt-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Back to servers"
          onClick={onBack}
          className="size-8"
        >
          <ArrowLeft aria-hidden className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div
            role="heading"
            aria-level={1}
            className="text-lg font-semibold text-foreground"
          >
            <ServerDetailIdentity controller={controller} />
          </div>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <ServerDetailConnectionControls controller={controller} />
        </div>
      </header>
      <div className="px-6 pb-3">
        <CaptureBanner
          status={status}
          capturedAt={selected.capturedAt}
          latestAttempt={selected.latestAttempt}
          probeFailures={selected.probeFailures}
          contexts={selected.contexts}
          selectedContextHash={selected.contextHash}
          onSelectContext={setContextHash}
          refresh={refresh.state}
          onRefresh={refresh.refresh}
          onRunChecks={runChecks}
          onConnect={connect}
          connecting={connection.isReconnecting || connection.toggleDisabled}
        />
      </div>
      <div className="min-h-0 flex-1 px-4 pb-4">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={62} minSize={40}>
            <div className="h-full min-h-0 pr-2">
              {evidence.status === "error" ? (
                <div
                  role="alert"
                  className="flex h-full items-center justify-center rounded-xl border border-border px-6 text-center text-sm text-muted-foreground"
                >
                  Saved feature evidence could not be loaded. Reload the page to
                  try again.
                </div>
              ) : evidence.status === "loading" ? (
                <Skeleton className="h-full w-full rounded-xl" />
              ) : (
                <ServerFeatureMap
                  root={{
                    name: server.name,
                    version:
                      typeof declaredVersion === "string"
                        ? declaredVersion
                        : controller.version,
                    protocolVersion,
                    featureCount: Object.values(evaluation.totals).reduce(
                      (sum, n) => sum + n,
                      0,
                    ),
                  }}
                  cards={cards}
                  selectedId={url.featureId && selection ? url.featureId : null}
                  onSelect={url.setFeature}
                  onOpenRun={openRun}
                />
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={38} minSize={28}>
            <div className="h-full min-h-0 pl-2">
              <ServerCanvasSidePanel
                controller={controller}
                detail={detail}
                projectXaaDefaultIdentity={projectXaaDefaultIdentity}
                evaluatedCapabilities={capabilities}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
