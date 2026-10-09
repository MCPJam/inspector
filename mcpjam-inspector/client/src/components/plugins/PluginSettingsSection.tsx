import { useState } from "react";
import { ChevronRight, Loader2, Package, Wrench } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { usePluginOnboardingIntentStore } from "@/lib/plugin-onboarding-intent";
import {
  usePluginManagementActions,
  usePluginSetupStatus,
  usePluginVersion,
  useProjectPlugin,
} from "@/hooks/usePluginImportApi";
import { useProjectMembers, useServerMutations } from "@/hooks/useProjects";
import { useActivePlugins } from "@/hooks/useActivePlugins";
import {
  PluginServerSetupEditor,
  hasPluginServerSetupEntries,
} from "./PluginServerSetup";
import { PluginIcon } from "./PluginIcon";
import { PluginUninstallDialog } from "./PluginUninstallDialog";
import {
  describePluginPlacement,
  describePluginReadiness,
  shortBundleHash,
} from "./plugin-presentation";
import {
  PLUGIN_ADMIN_ONLY_REASON,
  describePluginStatus,
  pluginStatusDotClass,
} from "./plugin-status";

/**
 * A plugin's lifecycle, where its parts live: the Settings tab of one of its
 * servers, or the detail of one of its skills when it has no servers.
 *
 * Status and versions first; setup per server component; Enable/Disable and
 * Uninstall last. Lifecycle actions are project-admin only on the backend,
 * so a member sees them disabled with the reason instead of a refusal on
 * click. Setup values are not admin-only.
 */
export function PluginSettingsSection({
  projectId,
  pluginId,
  focusServerId = null,
  onUninstalled,
}: {
  /** The Convex project id. */
  projectId: string | null;
  pluginId: string;
  /** The server this section was opened from; its setup is listed first. */
  focusServerId?: string | null;
  /** Called once the plugin is uninstalled (its parts are gone). */
  onUninstalled?: () => void;
}) {
  const detail = useProjectPlugin(pluginId);
  const activeVersionId = detail?.activeVersionId ?? null;
  const version = usePluginVersion(activeVersionId);
  const setupStatus = usePluginSetupStatus(activeVersionId);
  const { plugins: activeRows } = useActivePlugins(projectId);
  const row = activeRows.find((plugin) => plugin.pluginId === pluginId);
  const { isAuthenticated } = useConvexAuth();
  const { canManageMembers, isLoading: membersLoading } = useProjectMembers({
    isAuthenticated,
    projectId,
  });
  // Fails closed while membership loads; the reason only shows once known.
  const canManage = canManageMembers === true;
  const management = usePluginManagementActions();
  // Plugin server rows are structurally read-only, but the credential-only
  // write path accepts env/header values for them.
  const { updateServerWithClientSecret } = useServerMutations();
  const [pending, setPending] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [showOtherVersions, setShowOtherVersions] = useState(false);
  const [configuringComponentId, setConfiguringComponentId] = useState<
    string | null
  >(null);

  if (!detail) {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="plugin-settings-loading"
      >
        Loading plugin…
      </p>
    );
  }

  const label = detail.displayName || detail.name;
  const status = describePluginStatus({
    enabled: detail.enabled,
    activeVersionId,
    row,
  });
  const readyVersions = detail.versions.filter(
    (candidate) => candidate.status === "ready",
  );
  const activeVersion = readyVersions.find(
    (candidate) => candidate.pluginVersionId === activeVersionId,
  );
  const otherVersions = readyVersions.filter(
    (candidate) => candidate.pluginVersionId !== activeVersionId,
  );
  const serverComponents = [...(version?.servers ?? [])].sort(
    (a, b) =>
      Number(b.materializedServerId === focusServerId) -
      Number(a.materializedServerId === focusServerId),
  );
  const onboardingServerIds = serverComponents.flatMap((component) =>
    component.materializedServerId ? [component.materializedServerId] : [],
  );
  const offersOnboarding =
    !!projectId &&
    detail.enabled &&
    !!version?.onboarding &&
    onboardingServerIds.length > 0;
  const lifecycleDisabled = !canManage || pending;

  const runAction = async (what: string, run: () => Promise<void>) => {
    setPending(true);
    try {
      await run();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : `Could not ${what}.`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="plugin-settings-section">
      <div className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Plugin
        </h4>
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
            <PluginIcon
              icons={detail.icons}
              kind="directory"
              className="h-8 w-8 object-contain"
              fallback={
                <Package
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden
                />
              }
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{label}</span>
              {version?.declaredVersion ? (
                <span className="text-xs text-muted-foreground">
                  v{version.declaredVersion}
                </span>
              ) : null}
            </div>
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              data-testid="plugin-status"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  pluginStatusDotClass(status.tone),
                )}
              />
              {status.label}
            </span>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Version</p>
        {activeVersion ? (
          <div className="flex items-center gap-2 text-xs">
            <code className="rounded bg-muted px-1 py-0.5">
              {shortBundleHash(activeVersion.bundleHash)}
            </code>
            {activeVersion.declaredVersion ? (
              <span className="text-muted-foreground">
                v{activeVersion.declaredVersion}
              </span>
            ) : null}
            <Badge variant="secondary" className="font-normal">
              Active
            </Badge>
          </div>
        ) : otherVersions.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            No version is active yet. Activate one to run this plugin in chats.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No version is active. Import the plugin again and choose “Install
            and connect” to activate one.
          </p>
        )}
        {otherVersions.length > 0 ? (
          <div className="space-y-1.5">
            {/* Nothing active ("Install only"): its ready versions are the
                point of this section, so they are listed, not folded. */}
            {activeVersion ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={showOtherVersions}
                onClick={() => setShowOtherVersions((open) => !open)}
              >
                <ChevronRight
                  className={cn(
                    "h-3 w-3 transition-transform",
                    showOtherVersions && "rotate-90",
                  )}
                  aria-hidden
                />
                {otherVersions.length === 1
                  ? "1 other version"
                  : `${otherVersions.length} other versions`}
              </button>
            ) : null}
            {showOtherVersions || !activeVersion ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Activating a version changes what chats run from the next
                  message.
                </p>
                <ul className="space-y-1">
                  {otherVersions.map((candidate) => (
                    <li
                      key={candidate.pluginVersionId}
                      className="flex items-center gap-2 text-xs"
                    >
                      <code className="rounded bg-muted px-1 py-0.5">
                        {shortBundleHash(candidate.bundleHash)}
                      </code>
                      {candidate.declaredVersion ? (
                        <span className="text-muted-foreground">
                          v{candidate.declaredVersion}
                        </span>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="ml-auto h-6 px-2 text-xs"
                        disabled={lifecycleDisabled}
                        aria-label={`Activate ${shortBundleHash(candidate.bundleHash)}`}
                        onClick={() =>
                          void runAction("activate that version", async () => {
                            await management.activateVersion(
                              pluginId,
                              candidate.pluginVersionId,
                            );
                            track("plugin_version_upgraded", {
                              location: "plugin_settings",
                            });
                          })
                        }
                      >
                        Activate
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {serverComponents.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Setup</p>
          <ul className="space-y-1.5">
            {serverComponents.map((component) => {
              const readiness = setupStatus?.components.find(
                (candidate) =>
                  candidate.componentKey === component.componentKey,
              )?.readiness;
              const described = readiness
                ? describePluginReadiness(readiness)
                : null;
              const materializedServerId = component.materializedServerId;
              const canConfigure =
                materializedServerId !== undefined &&
                hasPluginServerSetupEntries(component);
              const isConfiguring =
                configuringComponentId === component.componentId;
              return (
                <li key={component.componentId} className="space-y-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <Wrench
                      className="h-3 w-3 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="truncate font-medium">
                      {component.declaredName}
                    </span>
                    <span className="text-muted-foreground">
                      {describePluginPlacement(component.placement)}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {described ? (
                        <span
                          className="text-muted-foreground"
                          title={described.detail}
                          data-testid="plugin-component-readiness"
                        >
                          {described.label}
                        </span>
                      ) : null}
                      {canConfigure ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={pending}
                          aria-expanded={isConfiguring}
                          onClick={() =>
                            setConfiguringComponentId(
                              isConfiguring ? null : component.componentId,
                            )
                          }
                          data-testid="plugin-component-configure"
                        >
                          Configure
                        </Button>
                      ) : null}
                    </span>
                  </div>
                  {isConfiguring && materializedServerId ? (
                    <PluginServerSetupEditor
                      envRequirements={component.envRequirements}
                      headerRequirements={component.headerRequirements}
                      busy={pending}
                      onCancel={() => setConfiguringComponentId(null)}
                      onSave={(values) =>
                        runAction("save the setup values", async () => {
                          await updateServerWithClientSecret({
                            serverId: materializedServerId,
                            ...(values.env ? { env: values.env } : {}),
                            ...(values.headers
                              ? { headers: values.headers }
                              : {}),
                          } as any);
                          track("plugin_component_configured", {
                            location: "plugin_settings",
                            env: Boolean(values.env),
                            headers: Boolean(values.headers),
                          });
                          setConfiguringComponentId(null);
                        })
                      }
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <div className="space-y-1.5 border-t border-border/60 pt-3">
        <div className="flex flex-wrap items-center gap-2">
          {offersOnboarding ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => {
                // Same path as the import dialog's "Set up": the Playground
                // runs the onboarding skill once one of these servers offers it.
                usePluginOnboardingIntentStore.getState().request({
                  projectId: projectId!,
                  serverIds: onboardingServerIds,
                  pluginName: label,
                  conversation: "new",
                });
                navigateApp(routePaths.playground);
              }}
              data-testid="plugin-onboarding-setup"
            >
              Set up {label}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={lifecycleDisabled}
            onClick={() =>
              void runAction(
                detail.enabled ? "disable the plugin" : "enable the plugin",
                async () => {
                  await management.setEnabled(pluginId, !detail.enabled);
                  if (detail.enabled) {
                    track("plugin_disabled", { location: "plugin_settings" });
                  }
                },
              )
            }
            data-testid="plugin-toggle-enabled"
          >
            {pending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
            {detail.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={lifecycleDisabled}
            onClick={() => setConfirmUninstall(true)}
            data-testid="plugin-uninstall"
          >
            Uninstall plugin…
          </Button>
        </div>
        {!canManage && !membersLoading ? (
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="plugin-admin-only-reason"
          >
            {PLUGIN_ADMIN_ONLY_REASON}
          </p>
        ) : null}
      </div>

      <PluginUninstallDialog
        open={confirmUninstall}
        onOpenChange={setConfirmUninstall}
        pluginLabel={label}
        onConfirm={() =>
          void runAction("uninstall the plugin", async () => {
            await management.softDeletePlugin(pluginId);
            track("plugin_uninstalled", { location: "plugin_settings" });
            onUninstalled?.();
          })
        }
      />
    </section>
  );
}
