import { Loader2 } from "lucide-react";
import { useId } from "react";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import { HostCompatContent } from "@/components/compat/HostCompatContent";
import { ServerSettingsPanel } from "../host-workspace/ServerSettingsPanel";
import { ConnectionAccountsSection } from "./ConnectionAccountsSection";
import { EditServerFormContent } from "./EditServerFormContent";
import { ServerAuthSummary } from "./ServerAuthSummary";
import { ServerHistoryContent } from "./ServerHistoryContent";
import { ServerHistoryDriftChip } from "./ServerHistoryDriftChip";
import { ServerInfoContent } from "./ServerInfoContent";
import { ServerInfoToolsMetadataContent } from "./ServerInfoToolsMetadataContent";
import { EffectiveProtocolVersionChip } from "./shared/EffectiveProtocolVersionChip";
import type { ServerDetailController } from "./hooks/use-server-detail-controller";

/*
 * The parts of a project server's detail view, each drawn from a
 * `useServerDetailController` result. The modal and a full page wrap them in
 * their own layout; none of them adds padding or a scroll container.
 */

interface ControllerProps {
  controller: ServerDetailController;
}

/** The server's name and version, with the OpenAI App and MCP App marks. */
export function ServerDetailIdentity({ controller }: ControllerProps) {
  const { server, version, tools } = controller;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="truncate">{server.name}</span>
      {version && (
        <span className="text-sm text-muted-foreground font-normal flex-shrink-0">
          v{version}
        </span>
      )}
      {(tools.isOpenAIApp || tools.isOpenAIAppAndMCPApp) && (
        <img
          src="/openai_logo.png"
          alt="OpenAI App"
          className="h-5 w-5 flex-shrink-0"
          title="OpenAI App"
        />
      )}
      {(tools.isMCPApp || tools.isOpenAIAppAndMCPApp) && (
        <img
          src="/mcp.svg"
          alt="MCP App"
          className="h-5 w-5 flex-shrink-0 dark:invert"
          title="MCP App"
        />
      )}
    </div>
  );
}

/** History drift chip, wire-version chip, connection status and switch. */
export function ServerDetailConnectionControls({
  controller,
}: ControllerProps) {
  const { server, projectId, hostedServerId, tabs, connection, protocol } =
    controller;
  return (
    <>
      {tabs.showHistory && projectId && hostedServerId && (
        <ServerHistoryDriftChip
          projectId={projectId}
          serverId={hostedServerId}
          isViewing={controller.isOpen && tabs.active === "history"}
          onClick={() => tabs.select("history")}
        />
      )}
      <EffectiveProtocolVersionChip
        hostDefault={protocol.hostDefault}
        serverOverride={protocol.override}
      />
      <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
        {connection.isReconnecting ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
        ) : (
          <span
            className={`h-1.5 w-1.5 rounded-full ${connection.indicatorClassName}`}
          />
        )}
        <span>
          {connection.isReconnecting
            ? "Connecting..."
            : server.connectionStatus === "failed"
              ? `${connection.statusLabel} (${server.retryCount})`
              : connection.statusLabel}
        </span>
      </span>
      <Switch
        aria-label="Server connection"
        checked={connection.isConnected}
        disabled={connection.toggleDisabled}
        onCheckedChange={connection.toggle}
        className="cursor-pointer scale-75"
      />
    </>
  );
}

export function ServerConfigTabBody({
  controller,
  projectXaaDefaultIdentity,
}: ControllerProps & {
  /** Project default XAA test identity, shown as override placeholders. */
  projectXaaDefaultIdentity: { subject: string; email: string } | null;
}) {
  const { form, protocol, projectId, hostedServerId } = controller;
  return (
    <EditServerFormContent
      formState={form.state}
      isDuplicateServerName={form.isDuplicateServerName}
      projectId={projectId}
      hostedServerId={hostedServerId}
      projectXaaDefaultIdentity={projectXaaDefaultIdentity}
      mcpProtocolVersionOverride={protocol.override}
      hostDefaultMcpProtocolVersion={protocol.hostDefault}
      onMcpProtocolVersionOverrideChange={protocol.onOverrideChange}
    />
  );
}

/**
 * Save & Connect for the configuration form, or Reconnect for a connected
 * server with no edits. Submits the enclosing form when saving.
 */
export function ServerConfigSaveButton({ controller }: ControllerProps) {
  const { form, connection } = controller;
  const hintId = useId();
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {form.saveHint && (
        <p
          ref={form.saveHintRef}
          id={hintId}
          role="status"
          tabIndex={-1}
          className="text-xs text-muted-foreground"
        >
          {form.saveHint}
        </p>
      )}
      <Button
        ref={form.saveButtonRef}
        // The modal footer changes visibility with the tab. Do not transition
        // inherited visibility, so the button can take focus as Config opens.
        className="transition-colors"
        type={form.offersReconnect ? "button" : "submit"}
        onClick={
          form.offersReconnect
            ? () =>
                void connection.connect({
                  allowInteractiveOAuthFlow: false,
                })
            : undefined
        }
        aria-describedby={form.saveHint ? hintId : undefined}
        disabled={form.saveBlocked}
        size="sm"
      >
        {form.isSaving || connection.isReconnecting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {form.isSaving ? "Saving..." : "Reconnecting..."}
          </>
        ) : form.offersReconnect ? (
          "Reconnect"
        ) : (
          "Save & Connect"
        )}
      </Button>
    </div>
  );
}

/** Shown beside a Retry button when extension settings fail to load. */
export const SETTINGS_LOAD_FAILED =
  "Settings could not be loaded. Select Retry to load them again.";

/** The server's extension settings, once `settings.showBody` holds. */
export function ServerSettingsTabBody({ controller }: ControllerProps) {
  const { settings, server, hostedServerId } = controller;
  if (!settings.scope || !hostedServerId) return null;
  return settings.availability.failed ? (
    <div role="alert" className="space-y-2 p-4">
      <p>
        {settings.availability.errorMessage ?? SETTINGS_LOAD_FAILED}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={settings.availability.retry}
      >
        Retry
      </Button>
    </div>
  ) : (
    <ServerSettingsPanel
      scope={settings.scope}
      serverId={hostedServerId}
      serverName={server.name}
      launchProfile={settings.launchProfile}
      launchObservation={settings.launch}
    />
  );
}

export function ServerOverviewTabBody({
  controller,
  evaluatedCapabilities,
}: ControllerProps & {
  /** The server canvas's capability names; the modal leaves this unset. */
  evaluatedCapabilities?: readonly string[];
}) {
  const { server, connection, projectId, hostedServerId } = controller;
  return !connection.isConnected &&
    !server.lastError &&
    !server.lastOAuthTrace ? (
    <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground">
      Connect to view server overview
    </div>
  ) : (
    <ServerInfoContent
      sections="info"
      server={server}
      projectId={projectId}
      hostedServerId={hostedServerId}
      evaluatedCapabilities={evaluatedCapabilities}
    />
  );
}

export function ServerAuthTabBody({ controller }: ControllerProps) {
  const { server, auth, tabs, projectId, hostedServerId, isUserReady } =
    controller;
  return (
    <>
      <ServerAuthSummary
        auth={auth.summary}
        reveal={auth.reveal}
        serverKey={hostedServerId ?? server.name}
        onEditInConfig={() => tabs.select("configuration")}
      />
      <ConnectionAccountsSection
        projectId={projectId}
        serverId={hostedServerId}
        enabled={isUserReady && server.useOAuth === true}
        onAuthenticate={auth.authenticate}
        onSwitch={auth.switchAccount}
      />
      <ServerInfoContent
        sections="auth"
        server={server}
        projectId={projectId}
        hostedServerId={hostedServerId}
      />
    </>
  );
}

export function ServerToolsTabBody({ controller }: ControllerProps) {
  const { connection, tools } = controller;
  if (!connection.isConnected) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground">
        Connect to view tools metadata
      </div>
    );
  }
  if (tools.isLoading || (!tools.data && !tools.error)) {
    return (
      <div className="flex items-center justify-center gap-2 h-full min-h-[120px] text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading tools metadata...
      </div>
    );
  }
  if (tools.error) {
    return (
      <div className="flex flex-col items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground text-center gap-1">
        <span>Tools metadata could not be loaded. Reconnect the server to try again.</span>
        <span className="text-xs max-w-[400px] truncate">
          {tools.error.slice(0, 200)}
        </span>
      </div>
    );
  }
  return <ServerInfoToolsMetadataContent toolsData={tools.data} />;
}

/**
 * Per-client compatibility; degrades to transport and auth facts while
 * disconnected. `onClose` dismisses the surface when the report navigates
 * away.
 */
export function ServerClientsTabBody({
  controller,
  onClose,
}: ControllerProps & { onClose: () => void }) {
  const { server, tools, projectId, hostedServerId } = controller;
  return (
    <HostCompatContent
      server={server}
      toolsData={tools.data}
      toolsLoadStatus={tools.status}
      projectId={projectId}
      serverId={hostedServerId ?? undefined}
      onClose={onClose}
    />
  );
}

/** URL changes, command changes, and revisions, available while disconnected. */
export function ServerHistoryTabBody({ controller }: ControllerProps) {
  const { projectId, hostedServerId } = controller;
  if (!projectId || !hostedServerId) return null;
  return (
    <ServerHistoryContent
      key={hostedServerId}
      projectId={projectId}
      serverId={hostedServerId}
    />
  );
}
