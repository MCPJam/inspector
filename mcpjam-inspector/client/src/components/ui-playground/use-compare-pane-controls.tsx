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
  ModelSelection,
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
import { movePane } from "@/lib/compare-panes";
import type { RecoveryPane } from "@/lib/comparison-recovery-record";
import type { PaneOverrides } from "@/lib/compare-pane-overrides";
import {
  reasoningEffortOptions,
  reasoningEffortRouteForRow,
} from "@/lib/reasoning-effort-options";
import { RUNTIME_CHOSEN_MODEL_REASON } from "@/lib/runtime-chosen-model";
import {
  effectiveHarnessId,
  harnessAccountChoosesModel,
  HARNESS_DESCRIPTORS,
} from "@/shared/harness-descriptors";
import type { ModelDefinition } from "@/shared/types";
import { useComparePaneStore } from "@/stores/compare-pane-store";
import {
  ComparePaneSettings,
  ComparePaneSummary,
  type ComparePaneLane,
  type RenderComparePaneHeader,
} from "./compare-pane-settings";

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
  setPanePick: (paneId: string, pick: ModelSelection | undefined) => void;
  sections?: ComparePaneSections;
}) {
  const [openPaneId, setOpenPaneId] = useState<string | null>(null);
  const publishPanes = useComparePaneStore((state) => state.publishPanes);
  const selectPane = useComparePaneStore((state) => state.selectPane);

  // A pane that narrowed the chat's servers keeps only those still in it.
  const paneServerNames = useCallback(
    (pane: RecoveryPane): string[] | null =>
      pane.serverIds == null
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
              hostId: pane.target.kind === "host" ? pane.target.hostId : null,
              serverNames: paneServerNames(pane),
            };
          })
        : [],
    [active, panes, resolutions, paneServerNames],
  );
  useEffect(() => publishPanes(options), [options, publishPanes]);
  useEffect(() => () => publishPanes([]), [publishPanes]);

  const pick = useCallback(
    (paneId: string, row: ModelDefinition, effort?: ModelReasoningEffort) => {
      const selection = compareEffortSelection(row, orgConfig, effort);
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
      // A pane whose model is unavailable still gets settings, to pick another.
      const column = resolution.status === "ready" ? resolution.column : null;
      const blocked = resolution.status === "ready" ? null : resolution;
      const hostConfig = column?.hostConfig ?? blocked?.hostConfig;
      if (!hostConfig) return undefined;
      const label = column?.compareLabel ?? blocked?.compareLabel ?? "Client";
      const model = column?.model ?? blocked?.model;
      const rows = column?.modelRows ?? blocked?.modelRows ?? [];
      const harnessId = effectiveHarnessId(hostConfig);
      const accountPicks = harnessAccountChoosesModel(harnessId);
      const harnessName =
        harnessId && harnessId in HARNESS_DESCRIPTORS
          ? HARNESS_DESCRIPTORS[harnessId as Harness].displayName
          : null;
      const effort = selectionEffort(column?.selection);
      const levels = model
        ? reasoningEffortOptions(
            model,
            reasoningEffortRouteForRow(model, orgConfig),
            (harnessId ?? undefined) as Harness | undefined,
          )
        : [];
      const servers = paneServerNames(pane) ?? sharedServers;
      const modelControl = accountPicks ? (
        <div className="space-y-0.5">
          <p className="text-sm">{model?.name}</p>
          <p className="text-xs text-muted-foreground">
            {RUNTIME_CHOSEN_MODEL_REASON}
          </p>
        </div>
      ) : (
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
            model={modelControl}
            effort={
              model && levels.length > 0 && !accountPicks ? (
                <CompareCardEffort
                  model={model}
                  levels={levels}
                  value={effort}
                  onChange={(level) => pick(pane.paneId, model, level)}
                />
              ) : undefined
            }
            servers={
              serverIdByName.size === 0
                ? null
                : sharedServers
                    .filter((name) => serverIdByName.has(name))
                    .map((name) => ({ name, enabled: servers.includes(name) }))
            }
            onServerChange={(name, enabled) => setServer(pane, name, enabled)}
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
              ...(accountPicks && harnessName
                ? [`Chosen by ${harnessName}`]
                : []),
              ...(effort ? [`${reasoningEffortLabel(effort)} effort`] : []),
              serverCount(servers.length),
            ]}
          />
        ) : undefined,
      });
    },
    [
      openPaneId,
      orgConfig,
      panes,
      paneServerNames,
      pick,
      resolutions,
      restorePanes,
      sections,
      selectPane,
      serverIdByName,
      setServer,
      sharedServers,
    ],
  );

  /** Settings for a pane that renders no card, to choose another model. */
  const blockedPaneActions = useCallback(
    (paneId: string) =>
      renderPaneHeader(paneId)?.({ environmentId: null, pending: false })
        .actions,
    [renderPaneHeader],
  );

  return { renderPaneHeader, blockedPaneActions, paneServers };
}
