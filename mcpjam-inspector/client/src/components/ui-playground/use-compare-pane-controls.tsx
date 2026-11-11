import { isRuntimeAccountModel } from "@/shared/model-provider";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import type {
  ModelReasoningEffort,
  RequestedModelSelection,
} from "@mcpjam/sdk/browser";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { Button } from "@mcpjam/design-system/button";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { CompareCardEffort } from "@/components/chat-v2/compare-card-effort";
import { reasoningEffortLabel } from "@/components/effort/effort-control";
import type { OrgVisibleConfig } from "@/components/chat-v2/shared/model-helpers";
import type { PlaygroundClientResolution } from "@/lib/playground-client-columns";
import { compareEffortSelection } from "@/lib/compare-cards";
import {
  movePane,
  paneTargetKey,
  type ComparePaneTarget,
} from "@/lib/compare-panes";
import { buildComparePaneTarget } from "@/lib/compare-pane-target";
import type { ComparePaneEnvironment } from "@/hooks/use-compare-environment-panes";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import {
  paneEnvironmentOverrides,
  type PaneOverrides,
} from "@/lib/compare-pane-overrides";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import {
  effectiveHarnessId,
} from "@/shared/harness-descriptors";
import type { ModelDefinition } from "@/shared/types";
import { useComparePaneStore } from "@/stores/compare-pane-store";
import {
  ComparePaneSettings,
  ComparePaneSummary,
  type ComparePaneLane,
  type ComparePaneServer,
  type RenderComparePaneHeader,
} from "./compare-pane-settings";
import {
  ComparePaneTargetSelect,
  type ComparePaneTargetOption,
} from "./compare-pane-target-select";

/**
 * Sections a later change adds to every pane's settings, such as its Skills.
 * `lane.environmentId` is the hidden environment the pane's card composed.
 */
export type ComparePaneSections = (args: {
  pane: RecoveryPane;
  lane: ComparePaneLane;
}) => ReactNode;

function selectionEffort(
  selection: RequestedModelSelection | undefined,
): ModelReasoningEffort | undefined {
  return selection && selection.source !== "legacy"
    ? selection.settings?.reasoningEffort
    : undefined;
}

function serverCount(count: number): string {
  if (count === 0) return "No servers";
  return count === 1 ? "1 server" : `${count} servers`;
}

/**
 * Pane settings for Compare's client panes: each pane's model, effort and
 * servers, and its place in the lineup. Every change touches one pane. The
 * Tools sidebar follows the pane whose settings were opened last.
 */
export function useComparePaneControls({
  active,
  panes,
  resolutions,
  sharedServers,
  serverIdByName,
  orgConfig,
  restorePanes,
  setPaneOverrides,
  setPanePick,
  setPaneTarget,
  targets,
  paneEnvironments,
  sections,
}: {
  /** Compare is running clients; otherwise the sidebar shows single chat. */
  active: boolean;
  panes: readonly RecoveryPane[];
  resolutions: readonly PlaygroundClientResolution[];
  /** The composer's servers, which every pane uses unless it narrows them. */
  sharedServers: readonly string[];
  serverIdByName: ReadonlyMap<string, string>;
  orgConfig: OrgVisibleConfig | undefined;
  restorePanes: (panes: readonly RecoveryPane[]) => void;
  setPaneOverrides: (paneId: string, overrides: PaneOverrides) => void;
  setPanePick: (paneId: string, pick: RequestedModelSelection | undefined) => void;
  /** Runs a pane on another target; it starts a new conversation. */
  setPaneTarget: (paneId: string, target: ComparePaneTarget) => void;
  /** What a pane may run: clients, and environments when they are visible. */
  targets: {
    clients: readonly ComparePaneTargetOption[];
    environments: readonly ComparePaneTargetOption[];
  };
  paneEnvironments: ReadonlyMap<string, ComparePaneEnvironment>;
  sections?: ComparePaneSections;
}) {
  const [openPaneId, setOpenPaneId] = useState<string | null>(null);
  const publishPanes = useComparePaneStore((state) => state.publishPanes);
  const selectPane = useComparePaneStore((state) => state.selectPane);

  // A client pane that narrowed the chat's servers keeps only those still in
  // it. An environment pane's servers are the environment's, narrowed on the
  // wire (`environmentOverrides`), never the chat's.
  const paneServerNames = useCallback(
    (pane: RecoveryPane): string[] | null =>
      pane.serverIds == null || pane.target.kind === "environment"
        ? null
        : sharedServers.filter((name) => {
            const serverId = serverIdByName.get(name);
            return !!serverId && pane.serverIds!.includes(serverId);
          }),
    [sharedServers, serverIdByName],
  );

  const options = useMemo(
    () =>
      active
        ? panes.map((pane) => {
            const resolution = resolutions.find(
              (entry) =>
                (entry.status === "ready" ? entry.column : entry).compareId ===
                pane.paneId,
            );
            return {
              paneId: pane.paneId,
              label:
                (resolution?.status === "ready"
                  ? resolution.column.compareLabel
                  : resolution?.compareLabel) ?? "Client",
              hostId:
                pane.target.kind === "host"
                  ? pane.target.hostId
                  : (paneEnvironments.get(pane.paneId)?.preview?.host
                      .hostId ?? null),
              // Only while environments are visible to this member, so the
              // Tools rail never lists an environment the pane cannot run.
              ...(pane.target.kind === "environment" &&
              paneEnvironments.get(pane.paneId)?.visible
                ? {
                    environmentId: pane.target.environmentId,
                    environmentOverrides: paneEnvironmentOverrides(pane),
                  }
                : { environmentId: null }),
              serverNames: paneServerNames(pane),
              ...(pane.target.kind === "host" && pane.serverIds != null
                ? {
                    onServerConnected: (name: string) => {
                      const id = serverIdByName.get(name);
                      if (id) {
                        setPaneOverrides(pane.paneId, {
                          serverIds: [
                            ...new Set([...(pane.serverIds ?? []), id]),
                          ],
                        });
                      }
                    },
                  }
                : {}),
            };
          })
        : [],
    [
      active,
      panes,
      resolutions,
      paneServerNames,
      paneEnvironments,
      serverIdByName,
      setPaneOverrides,
    ],
  );
  useEffect(() => publishPanes(options), [options, publishPanes]);
  useEffect(() => () => publishPanes([]), [publishPanes]);

  const pick = useCallback(
    (paneId: string, row: ModelDefinition, effort?: ModelReasoningEffort) => {
      const selection = isRuntimeAccountModel(String(row.id))
        ? { source: "legacy" as const, modelId: String(row.id) }
        : compareEffortSelection(row, orgConfig, effort);
      if (selection) setPanePick(paneId, selection);
    },
    [orgConfig, setPanePick],
  );

  const setServer = useCallback(
    (pane: RecoveryPane, name: string, enabled: boolean) => {
      const current = paneServerNames(pane) ?? [...sharedServers];
      const names = enabled
        ? sharedServers.filter(
            (entry) => entry === name || current.includes(entry),
          )
        : current.filter((entry) => entry !== name);
      // Back to every server of the chat: follow it again, so servers added
      // later reach this pane too.
      const follows = names.length === sharedServers.length;
      setPaneOverrides(pane.paneId, {
        serverIds: follows
          ? null
          : names.flatMap((entry) => serverIdByName.get(entry) ?? []),
      });
    },
    [paneServerNames, serverIdByName, setPaneOverrides, sharedServers],
  );

  /** The pane's own servers for its card, or null to use the chat's. */
  const paneServers = useCallback(
    (paneId: string) => {
      const pane = panes.find((entry) => entry.paneId === paneId);
      const names = pane ? paneServerNames(pane) : null;
      return names
        ? {
            names,
            ids: names.flatMap((name) => serverIdByName.get(name) ?? []),
          }
        : null;
    },
    [panes, paneServerNames, serverIdByName],
  );

  /** An environment pane's servers: each on unless the pane narrowed them. */
  const environmentServers = useCallback(
    (pane: RecoveryPane) =>
      (paneEnvironments.get(pane.paneId)?.preview?.servers ?? []).map(
        (server) => ({
          serverId: server.serverId,
          name: server.name,
          source: server.source,
          enabled:
            pane.serverIds == null || pane.serverIds.includes(server.serverId),
        }),
      ),
    [paneEnvironments],
  );

  const setEnvironmentServer = useCallback(
    (pane: RecoveryPane, serverId: string, enabled: boolean) => {
      const all = environmentServers(pane);
      const ids = all.flatMap((server) =>
        (server.serverId === serverId ? enabled : server.enabled)
          ? [server.serverId]
          : [],
      );
      // Every server on again: follow the environment, so a server it adds
      // later reaches this pane too. `[]` stays an explicit "no servers".
      setPaneOverrides(pane.paneId, {
        serverIds: ids.length === all.length ? null : ids,
      });
    },
    [environmentServers, setPaneOverrides],
  );

  /**
   * The composer's "+" server rows while an environment pane is selected: its
   * environment's servers, toggled for that pane alone. Null for client panes,
   * which use the chat's rows.
   */
  const composerServers = useCallback(
    (paneId: string | null | undefined) => {
      const pane = panes.find((entry) => entry.paneId === paneId);
      if (
        pane?.target.kind !== "environment" ||
        !paneEnvironments.get(pane.paneId)?.preview
      )
        return null;
      return {
        environmentServers: environmentServers(pane),
        onEnvironmentServerToggle: (serverId: string, enabled: boolean) =>
          setEnvironmentServer(pane, serverId, enabled),
        environmentServersOverridden: pane.serverIds != null,
        onResetEnvironmentServers: () =>
          setPaneOverrides(pane.paneId, { serverIds: null }),
      };
    },
    [
      environmentServers,
      paneEnvironments,
      panes,
      setEnvironmentServer,
      setPaneOverrides,
    ],
  );

  /** The Apps an environment pane's lane sees: its environment's servers. */
  const environmentLaneServers = useMemo(
    () =>
      new Map(
        panes.flatMap((pane) =>
          pane.target.kind === "environment"
            ? [
                [
                  pane.paneId,
                  environmentServers(pane).flatMap((server) =>
                    server.enabled
                      ? [{ serverId: server.serverId, name: server.name }]
                      : [],
                  ),
                ] as const,
              ]
            : [],
        ),
      ),
    [panes, environmentServers],
  );

  /**
   * The pane's turn target and servers, for its card's hosted context. An
   * environment pane sends its narrowing only when it has one, so `null`
   * (follow the environment) and `[]` (no servers) stay apart on the wire.
   */
  const paneRequest = useCallback(
    (paneId: string, chatServerIds: string[]): HostedRuntimeContext => {
      const pane = panes.find((entry) => entry.paneId === paneId);
      if (!pane) return { selectedServerIds: chatServerIds };
      if (pane.target.kind === "host") {
        return {
          selectedServerIds: paneServers(paneId)?.ids ?? chatServerIds,
          ...buildComparePaneTarget({
            target: pane.target,
            hostId: pane.target.hostId,
          }),
        };
      }
      const overrides = paneEnvironmentOverrides(pane);
      return {
        selectedServerIds: chatServerIds,
        ...buildComparePaneTarget({
          target: pane.target,
          hostId: paneEnvironments.get(paneId)?.preview?.host.hostId,
          ...(overrides ? { overrides } : {}),
        }),
      };
    },
    [panes, paneServers, paneEnvironments],
  );

  const renderPaneHeader = useCallback(
    (paneId: string): RenderComparePaneHeader | undefined => {
      const index = panes.findIndex((pane) => pane.paneId === paneId);
      const pane = panes[index];
      const resolution = resolutions.find(
        (entry) =>
          (entry.status === "ready" ? entry.column : entry).compareId ===
          paneId,
      );
      if (!pane || !resolution) return undefined;
      // A blocked pane still gets settings, to pick another model or target.
      const column = resolution.status === "ready" ? resolution.column : null;
      const blocked = resolution.status === "ready" ? null : resolution;
      const hostConfig = column?.hostConfig ?? blocked?.hostConfig;
      const label = column?.compareLabel ?? blocked?.compareLabel ?? "Client";
      const environment =
        pane.target.kind === "environment"
          ? paneEnvironments.get(pane.paneId)
          : undefined;
      const model = column?.model ?? blocked?.model;
      const rows = column?.modelRows ?? blocked?.modelRows ?? [];
      const harnessId = hostConfig ? effectiveHarnessId(hostConfig) : null;
      const effort = selectionEffort(column?.selection);
      const levels = model
        ? reasoningEffortOptions(
            model,
            reasoningEffortRouteForRow(model, orgConfig),
            (harnessId ?? undefined) as Harness | undefined,
          )
        : [];
      const servers = paneServerNames(pane) ?? sharedServers;
      // An environment pane lists its environment's servers, by id.
      const serverRows: ComparePaneServer[] | null = environment
        ? environment.preview
          ? environmentServers(pane).map((server) => ({
              id: server.serverId,
              name: server.name,
              enabled: server.enabled,
            }))
          : null
        : serverIdByName.size === 0
          ? null
          : sharedServers
              .filter((name) => serverIdByName.has(name))
              .map((name) => ({ name, enabled: servers.includes(name) }));
      const enabledServers = environment
        ? (serverRows ?? []).filter((server) => server.enabled).length
        : servers.length;
      const listed = (
        options: readonly ComparePaneTargetOption[],
        kind: ComparePaneTarget["kind"],
      ) =>
        pane.target.kind !== kind ||
        options.some(
          (option) =>
            paneTargetKey(option.target) === paneTargetKey(pane.target),
        )
          ? options
          : [...options, { target: pane.target, label }];
      const targetControl = (
        <ComparePaneTargetSelect
          label={label}
          value={pane.target}
          clients={listed(targets.clients, "host")}
          environments={environment && !environment.visible ? [] : listed(targets.environments, "environment")}
          onChange={(next) => setPaneTarget(pane.paneId, next)}
        />
      );
      const modelControl = !hostConfig ? undefined : (
        <ModelSelector
          currentModel={
            model ?? {
              id: hostConfig.modelId,
              name: hostConfig.modelId,
              provider: "custom",
              disabled: true,
            }
          }
          availableModels={rows}
          onModelChange={(row) => pick(pane.paneId, row)}
          onModelEffortSelect={(row, level) => pick(pane.paneId, row, level)}
          rowEfforts={(row) => {
            const rowLevels = reasoningEffortOptions(
              row,
              reasoningEffortRouteForRow(row, orgConfig),
              (harnessId ?? undefined) as Harness | undefined,
            );
            return rowLevels.length > 0 ? { levels: rowLevels } : undefined;
          }}
          onAddProvider={null}
          align="start"
          analyticsLocation="playground_compare_pane_settings"
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-between"
              aria-label={`Model for ${label}`}
            >
              <span className="truncate">
                {model?.name ?? "Choose a model"}
              </span>
              <ChevronDown className="size-3.5 shrink-0" />
            </Button>
          }
        />
      );
      return (lane) => ({
        actions: (
          <ComparePaneSettings
            label={label}
            open={openPaneId === pane.paneId}
            onOpenChange={(open) => {
              setOpenPaneId(open ? pane.paneId : null);
              if (open) selectPane(pane.paneId);
            }}
            target={{
              title:
                targets.environments.length > 0 || environment?.visible
                  ? "Client or environment"
                  : "Client",
              control: targetControl,
            }}
            model={modelControl}
            effort={
              model && levels.length > 0 ? (
                <CompareCardEffort
                  model={model}
                  levels={levels}
                  value={effort}
                  onChange={(level) => pick(pane.paneId, model, level)}
                />
              ) : undefined
            }
            serverSource={environment ? "environment" : "chat"}
            servers={serverRows}
            onServerChange={(key, enabled) =>
              environment
                ? setEnvironmentServer(pane, key, enabled)
                : setServer(pane, key, enabled)
            }
            canMoveLeft={index > 0}
            canMoveRight={index < panes.length - 1}
            onMove={(offset) =>
              restorePanes(movePane(panes, pane.paneId, offset))
            }
          >
            {sections?.({ pane, lane })}
          </ComparePaneSettings>
        ),
        summary: model ? (
          <ComparePaneSummary
            modelName={model.name}
            details={[
              ...(environment?.preview?.host.hostName
                ? [environment.preview.host.hostName]
                : []),
              ...(effort ? [`${reasoningEffortLabel(effort)} effort`] : []),
              serverCount(enabledServers),
            ]}
          />
        ) : undefined,
      });
    },
    [
      environmentServers,
      openPaneId,
      orgConfig,
      paneEnvironments,
      panes,
      paneServerNames,
      pick,
      resolutions,
      restorePanes,
      sections,
      selectPane,
      serverIdByName,
      setEnvironmentServer,
      setPaneTarget,
      setServer,
      sharedServers,
      targets,
    ],
  );

  /** Settings for a pane that renders no card, to choose another model. */
  const blockedPaneActions = useCallback(
    (paneId: string) =>
      renderPaneHeader(paneId)?.({ environmentId: null, pending: false })
        .actions,
    [renderPaneHeader],
  );

  return {
    renderPaneHeader,
    blockedPaneActions,
    paneServers,
    paneRequest,
    environmentLaneServers,
    composerServers,
  };
}
