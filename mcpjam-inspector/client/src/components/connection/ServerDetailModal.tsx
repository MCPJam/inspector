import { useSettingsLaunchObservation } from "@/lib/use-extension-launch-health";
import type { ExtensionLaunchProfile } from "@/lib/extension-launch-health";
import { SettingsDialogPresentationProvider, useSettingsDialogPresentation } from "../host-workspace/settings-dialog-presentation";
import { ServerSettingsPanel } from "../host-workspace/ServerSettingsPanel";
import { useServerSettingsAvailability } from "../host-workspace/use-server-settings";
import type { ThreadAppScope } from "../host-workspace/thread-app-api";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@mcpjam/design-system/tabs";
import { Badge } from "@mcpjam/design-system/badge";
import { PluginSettingsSection } from "@/components/plugins/PluginSettingsSection";
import {
  useServerDetailController,
  type ServerDetailControllerOptions,
  type ServerDetailTab,
} from "./hooks/use-server-detail-controller";
import {
  ServerAuthTabBody,
  ServerClientsTabBody,
  ServerConfigSaveButton,
  ServerConfigTabBody,
  ServerDetailConnectionControls,
  ServerDetailIdentity,
  ServerHistoryTabBody,
  ServerOverviewTabBody,
  ServerSettingsTabBody,
  ServerToolsTabBody,
  SETTINGS_LOAD_FAILED,
} from "./ServerDetailTabBodies";

export type { ServerDetailTab } from "./hooks/use-server-detail-controller";

interface ServerDetailModalProps extends ServerDetailControllerOptions {
  /** A project server; see {@link PluginServerDetailModalProps} for a plugin's. */
  plugin?: undefined;
  /** Project default XAA test identity — shown as override placeholders. */
  projectXaaDefaultIdentity?: { subject: string; email: string } | null;
}

/** A server an installed plugin adds, opened from its card or a permalink. */
export interface PluginServerDetail {
  pluginId: string;
  /** What the plugin's card is labelled with. */
  pluginLabel: string;
  /** The materialized server, or null for a plugin with no server to name. */
  serverId: string | null;
  serverName: string;
}

/**
 * A plugin's server is not a browser connection and its configuration belongs
 * to the plugin's version, so its details are its Settings tab alone: the
 * plugin's versions, setup and lifecycle, plus the server's own extension
 * settings when it declares any.
 */
interface PluginServerDetailModalProps {
  plugin: PluginServerDetail;
  isOpen: boolean;
  onClose: () => void;
  /** The Convex project id. */
  projectId?: string | null;
  extensionSettingsScope?: ThreadAppScope | null;
  extensionLaunchProfile?: ExtensionLaunchProfile;
}

export function ServerDetailModal(
  props: ServerDetailModalProps | PluginServerDetailModalProps
) {
  return (
    <SettingsDialogPresentationProvider>
      {props.plugin ? (
        <PluginServerDetailModal {...props} />
      ) : (
        <ProjectServerDetailModal {...props} />
      )}
    </SettingsDialogPresentationProvider>
  );
}

function PluginServerDetailModal({
  plugin,
  isOpen,
  onClose,
  projectId = null,
  extensionSettingsScope = null,
  extensionLaunchProfile,
}: PluginServerDetailModalProps) {
  const presentation = useSettingsDialogPresentation();
  const settings = useServerSettingsAvailability(
    isOpen ? extensionSettingsScope : null,
    plugin.serverId
  );
  const settingsLaunch = useSettingsLaunchObservation(
    JSON.stringify([extensionSettingsScope, plugin.serverId]),
    extensionLaunchProfile ?? "chatgpt",
    isOpen && !!extensionSettingsScope,
    settings.failed,
  );
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !presentation?.dismissApp()) onClose();
      }}
    >
      <DialogContent
        {...presentation?.contentProps}
        data-settings-dialog-app={presentation?.active || undefined}
        data-settings-dialog-fullscreen={presentation?.fullscreen || undefined}
        translate="no"
        className="notranslate sm:max-w-2xl max-h-[85vh] flex flex-col overflow-hidden outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        data-testid="plugin-server-detail-modal"
      >
        <DialogHeader data-settings-dialog-header>
          {/* No connect switch: plugin servers connect on every message. The
              Plugin section below says whether chats run the plugin now. */}
          <DialogTitle className="flex items-center gap-2 min-w-0 pr-6">
            <span className="truncate">{plugin.serverName}</span>
            {/* Without a server, the title is the plugin itself. */}
            {plugin.serverId ? (
              <Badge
                variant="secondary"
                className="flex-shrink-0 text-[10px] font-normal"
              >
                from {plugin.pluginLabel}
              </Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Manage this plugin's versions, setup and lifecycle.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          data-settings-layout
          value="settings"
          className="flex min-h-0 flex-col"
        >
          <TabsList
            data-settings-dialog-chrome
            className="-ml-1 flex h-9 w-full p-[3px]"
          >
            <TabsTrigger
              value="settings"
              className="min-w-0 flex-1 px-1.5 text-xs sm:px-2 sm:text-sm"
            >
              Settings
            </TabsTrigger>
          </TabsList>
          <TabsContent
            data-settings-layout
            value="settings"
            className="mt-4 max-h-[60vh] overflow-y-auto pl-1 pr-2"
          >
            <div data-settings-background>
              <PluginSettingsSection
                projectId={projectId}
                pluginId={plugin.pluginId}
                focusServerId={plugin.serverId}
                onUninstalled={onClose}
              />
            </div>
            {isOpen &&
            extensionSettingsScope &&
            plugin.serverId &&
            (settings.available || settings.failed) ? (
              <div
                data-settings-layout
                className="mt-4 border-t border-border/60 pt-4"
              >
                {settings.failed ? (
                  <div role="alert" className="space-y-2">
                    <p>{settings.errorMessage ?? SETTINGS_LOAD_FAILED}</p>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={settings.retry}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <ServerSettingsPanel
                    scope={extensionSettingsScope}
                    serverId={plugin.serverId}
                    serverName={plugin.serverName}
                    launchProfile={extensionLaunchProfile}
                    launchObservation={settingsLaunch}
                  />
                )}
              </div>
            ) : null}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function ProjectServerDetailModal({
  onClose,
  projectXaaDefaultIdentity = null,
  ...options
}: ServerDetailModalProps) {
  const presentation = useSettingsDialogPresentation();
  const controller = useServerDetailController({ ...options, onClose });
  const { isOpen, tabs, form } = controller;
  const tabTriggerClass = "min-w-0 flex-1 px-1.5 text-xs sm:px-2 sm:text-sm";
  const isConfigurationTab = tabs.active === "configuration";
  // Every tab but Configuration overlays the force-mounted configuration
  // panel. Configuration's own classes are NOT reusable here: it keeps
  // `invisible` while inactive, which still occupies layout, so a sibling in
  // normal flow stacks below its full height and spills out of the dialog.
  const overlayTabClass =
    "mt-0 flex-none absolute inset-0 overflow-y-auto bg-background";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && presentation?.dismissApp()) return;
        if (!open) controller.close();
      }}
    >
      <DialogContent
        {...presentation?.contentProps}
        data-settings-dialog-app={presentation?.active || undefined}
        data-settings-dialog-fullscreen={presentation?.fullscreen || undefined}
        // Browser translators rewrite text nodes in-place. React then cannot
        // safely remove this portaled dialog after its close animation.
        translate="no"
        // The `sm:` prefix is load-bearing. DialogContent's base carries
        // `sm:max-w-lg`, and tailwind-merge only collapses classes that
        // share a variant — so an unprefixed `max-w-2xl` never conflicts
        // with it, and the narrower `sm:` rule wins on every viewport
        // >= 640px. Measured: the header was 462px (= 512 - padding -
        // border) instead of the 622px this line asks for. Prefixing also
        // spares the base `max-w-[calc(100%-2rem)]`, which tailwind-merge
        // used to drop as a same-variant conflict — that's the guard that
        // keeps the dialog off both screen edges below 640px.
        className="notranslate sm:max-w-2xl max-h-[85vh] flex flex-col outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
      >
        <DialogHeader data-settings-dialog-header>
          <DialogTitle
            // `flex-wrap` is what keeps the server name on screen. The
            // status cluster opposite it is `flex-shrink-0`, and inside
            // this group only the name can shrink (version + logos are
            // `flex-shrink-0`, and `truncate`'s `overflow:hidden` lets it
            // collapse past its text). So every pixel of deficit landed on
            // the name alone: adding the "Tools changed" chip took it from
            // 88px to 8px without the window moving. Wrapping moves the
            // cluster to its own row instead of squeezing the name, and
            // stops it overflowing the dialog on narrow viewports.
            className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
          >
            <ServerDetailIdentity controller={controller} />
            <div className="flex items-center gap-1.5 flex-shrink-0 mr-6">
              <ServerDetailConnectionControls controller={controller} />
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            View server details, edit configuration, and manage connection
          </DialogDescription>
        </DialogHeader>

        <form
          data-settings-layout
          onSubmit={form.submit}
          className="flex min-h-0 flex-col"
        >
          <Tabs
            data-settings-layout
            value={tabs.active}
            onValueChange={(v) => tabs.select(v as ServerDetailTab)}
            className="flex min-h-0 flex-col"
          >
            <TabsList
              data-settings-dialog-chrome
              className="-ml-1 flex h-9 w-full shrink-0 p-[3px]"
            >
              {tabs.visible.map((tab) => (
                <TabsTrigger
                  key={tab.id}
                  value={tab.id}
                  aria-label={tab.ariaLabel}
                  className={tabTriggerClass}
                >
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            <div
              data-settings-layout
              className="relative mt-4 -mr-6 -ml-1 flex min-h-0 flex-col overflow-hidden"
            >
              {/* Configuration: always rendered via forceMount, sets container height */}
              <TabsContent
                data-settings-background
                value="configuration"
                forceMount
                className="mt-0 min-h-0 max-h-[60vh] overflow-y-auto data-[state=inactive]:invisible"
              >
                <div className="pl-1 pr-6">
                  <ServerConfigTabBody
                    controller={controller}
                    projectXaaDefaultIdentity={projectXaaDefaultIdentity}
                  />
                </div>
              </TabsContent>

              {/* Footer inside the relative container so overlays cover it */}
              <DialogFooter
                data-settings-dialog-chrome
                data-testid="modal-footer"
                className="min-h-9 flex-shrink-0 pt-4 pl-1 pr-6 border-t border-border/50 sm:justify-end data-[state=inactive]:invisible"
                style={{
                  visibility: isConfigurationTab ? "visible" : "hidden",
                }}
              >
                <ServerConfigSaveButton controller={controller} />
              </DialogFooter>

              {controller.settings.showBody && (
                <TabsContent
                  data-settings-layout
                  value="settings"
                  forceMount
                  className="mt-0 absolute inset-0 overflow-y-auto bg-background data-[state=inactive]:hidden"
                >
                  <ServerSettingsTabBody controller={controller} />
                </TabsContent>
              )}

              <TabsContent value="overview" className={overlayTabClass}>
                <div className="pl-1 pr-6">
                  <ServerOverviewTabBody controller={controller} />
                </div>
              </TabsContent>

              {tabs.showAuthorization && (
                <TabsContent value="authorization" className={overlayTabClass}>
                  <div className="space-y-4 pl-1 pr-6">
                    <ServerAuthTabBody controller={controller} />
                  </div>
                </TabsContent>
              )}

              <TabsContent value="tools-metadata" className={overlayTabClass}>
                <div className="pl-1 pr-6">
                  <ServerToolsTabBody controller={controller} />
                </div>
              </TabsContent>

              <TabsContent value="compatibility" className={overlayTabClass}>
                <div className="pl-1 pr-6">
                  <ServerClientsTabBody
                    controller={controller}
                    onClose={onClose}
                  />
                </div>
              </TabsContent>

              {tabs.showHistory &&
                controller.projectId &&
                controller.hostedServerId && (
                  <TabsContent value="history" className={overlayTabClass}>
                    <div className="pl-1 pr-6">
                      <ServerHistoryTabBody controller={controller} />
                    </div>
                  </TabsContent>
                )}
            </div>
          </Tabs>
        </form>
      </DialogContent>
    </Dialog>
  );
}
