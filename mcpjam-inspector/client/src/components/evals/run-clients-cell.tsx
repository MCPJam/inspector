import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { findHostStyle } from "@/lib/client-styles";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import {
  modelDisplayName,
  ModelDisplayNamesContext,
} from "@/lib/model-display-name";
import { useContext } from "react";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type { SuiteRunHistoryRow } from "../evaluate/suite-detail-model";

export const VISIBLE_RUN_CLIENT_PAIRINGS = 2;

type ClientModelPairing = {
  client: string;
  clientId?: string;
  clientVersionId?: string;
  clientVersionNumber?: number;
  hostStyle?: string;
  models: string[];
};

function pairingLabel(
  mapping: ClientModelPairing,
  modelName: (id: string) => string,
): string {
  const models = mapping.models.map(modelName).join(", ") || "-";
  const version = mapping.clientVersionNumber
    ? ` · v${mapping.clientVersionNumber}`
    : "";
  return `${mapping.client}${version} · ${models}`;
}

/** Recorded client/model pairs, never a cross product of two independent lists. */
export function RunClientsCell({
  rows,
  column,
}: {
  rows: Pick<
    SuiteRunHistoryRow,
    | "client"
    | "models"
    | "hostStyle"
    | "clientId"
    | "clientVersionId"
    | "clientVersionNumber"
  >[];
  column?: "client" | "model";
}) {
  const availableModels = useContext(ModelDisplayNamesContext);
  const modelName = (id: string) => modelDisplayName(id, availableModels);
  const clientLabel = (mapping: ClientModelPairing) =>
    mapping.clientVersionNumber
      ? `${mapping.client} · v${mapping.clientVersionNumber}`
      : mapping.client;
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const mappings = [
    ...new Map(
      rows.map((row) => [
        JSON.stringify([
          row.clientId,
          row.client,
          row.clientVersionId,
          row.clientVersionNumber,
          row.models,
        ]),
        {
          client:
            row.client === "SDK harness" && !row.clientId
              ? "-"
              : (row.client ?? "-"),
          models: row.models.filter(
            (model) => model.trim() && model.trim().toLowerCase() !== "n/a",
          ),
          hostStyle: row.hostStyle,
          clientId: row.clientId,
          clientVersionId: row.clientVersionId,
          clientVersionNumber: row.clientVersionNumber,
        },
      ]),
    ).values(),
  ];
  if (!mappings.length) return <span className="text-muted-foreground">—</span>;

  const entries =
    column === "client"
      ? [
          ...new Map(
            mappings.map((mapping) => [
              JSON.stringify([
                mapping.clientId,
                mapping.client,
                mapping.clientVersionId,
                mapping.clientVersionNumber,
              ]),
              mapping,
            ]),
          ).values(),
        ]
      : mappings;
  const visible = entries.slice(0, VISIBLE_RUN_CLIENT_PAIRINGS);
  const hidden = entries.slice(VISIBLE_RUN_CLIENT_PAIRINGS);
  const allLabels = entries.map((mapping) =>
    column === "client"
      ? clientLabel(mapping)
      : pairingLabel(mapping, modelName),
  );
  const models = [...new Set(mappings.flatMap((mapping) => mapping.models))];
  // Each column announces ITS OWN values. One shared pairing list made the
  // Client and Model cells read out the same sentence twice per row.
  const columnLabel =
    column === "client"
      ? entries.map((mapping) => mapping.client).join(", ")
      : column === "model"
        ? models.map(modelName).join(", ") || "-"
        : allLabels.join(", ");
  // The expanded model column lists models, so its overflow counts models —
  // the pairing count belongs to the columns that show pairings.
  const visibleModels = models.slice(0, VISIBLE_RUN_CLIENT_PAIRINGS);
  const hiddenModels = models.slice(VISIBLE_RUN_CLIENT_PAIRINGS);

  if (
    (column === "model" && models.length === 0) ||
    (column === "client" && mappings.every((mapping) => mapping.client === "-"))
  ) {
    return <span className="text-muted-foreground">-</span>;
  }

  const logo = (client: string, hostStyle?: string) => (
    <span className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
      <img
        src={
          hostStyle && findHostStyle(hostStyle)
            ? getScenarioHostLogo(hostStyle, undefined, theme)
            : resolveHostLogoByName(client, theme)
        }
        alt=""
        className="size-2.5 object-contain"
      />
    </span>
  );

  return (
    <>
      {column === "model" && (
        <span
          data-testid="compact-run-models"
          className="flex max-w-48 items-center gap-1.5 @min-[1100px]/run-history:hidden"
        >
          <span
            className="min-w-0 truncate text-xs text-muted-foreground"
            title={models[0] ? modelName(models[0]) : undefined}
          >
            {models[0] ? modelName(models[0]) : "-"}
          </span>
          {models.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  aria-label={`${models.length - 1} more models`}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="shrink-0 text-xs text-muted-foreground focus-visible:outline-ring"
                >
                  +{models.length - 1}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <ul>
                  {models.slice(1).map((model) => (
                    <li key={model}>{modelName(model)}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      )}
      <span
        data-testid={column === "model" ? "expanded-run-models" : undefined}
        // Both columns sit on ONE line, the way the suites list shows them.
        // Stacking made a two-client run twice as tall as a one-client run,
        // so the table's row height read as a result.
        className={
          column === "model"
            ? "hidden min-w-0 max-w-80 items-center gap-2 @min-[1100px]/run-history:flex"
            : "flex min-w-0 max-w-80 items-center gap-2"
        }
        aria-label={columnLabel}
      >
        {column === "model"
          ? visibleModels.map((model) => (
              <span
                key={model}
                title={modelName(model)}
                className="min-w-0 shrink truncate text-xs text-muted-foreground"
              >
                {modelName(model)}
              </span>
            ))
          : visible.map((mapping, index) => (
              <Tooltip
                key={`${mapping.client}-${mapping.clientVersionId}-${index}`}
              >
                <TooltipTrigger asChild>
                  <span
                    tabIndex={mapping.clientVersionNumber ? 0 : undefined}
                    className="inline-flex min-w-0 items-center gap-1.5"
                  >
                    {mapping.client !== "-" &&
                      logo(mapping.client, mapping.hostStyle)}
                    <span
                      className={
                        column === "client" && mapping.client !== "-"
                          ? "hidden truncate text-xs @min-[1100px]/run-history:inline"
                          : "truncate text-xs"
                      }
                    >
                      {mapping.client}
                      {!column && (
                        <span className="text-muted-foreground">
                          {" · "}
                          {mapping.models.map(modelName).join(", ") || "-"}
                        </span>
                      )}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{clientLabel(mapping)}</TooltipContent>
              </Tooltip>
            ))}
        {(column === "model" ? hiddenModels : hidden).length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="inline-flex h-5 shrink-0 items-center rounded-sm px-1 text-[10px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-ring"
                aria-label={
                  column === "model"
                    ? `${hiddenModels.length} more models`
                    : column === "client"
                      ? `${hidden.length} more clients`
                      : `${hidden.length} more client and model pairings`
                }
              >
                +{column === "model" ? hiddenModels.length : hidden.length}
              </span>
            </TooltipTrigger>
            <TooltipContent
              align="start"
              variant="muted"
              side="bottom"
              sideOffset={6}
              className="max-w-xs text-left"
            >
              <ul className="space-y-1">
                {column === "model"
                  ? hiddenModels.map((id) => <li key={id}>{modelName(id)}</li>)
                  : allLabels.map((label, index) => (
                      <li key={index}>{label}</li>
                    ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </>
  );
}
