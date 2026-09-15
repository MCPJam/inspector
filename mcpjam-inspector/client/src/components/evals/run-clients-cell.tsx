import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { findHostStyle } from "@/lib/client-styles";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import { compactModelIdTail } from "@/lib/environment-label";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type { SuiteRunHistoryRow } from "../evaluate/suite-detail-model";

export const VISIBLE_RUN_CLIENT_PAIRINGS = 2;

type ClientModelPairing = {
  client: string;
  hostStyle?: string;
  models: string[];
};

function pairingLabel(mapping: ClientModelPairing): string {
  const models = mapping.models.map(compactModelIdTail).join(", ") || "-";
  return `${mapping.client} · ${models}`;
}

/** Recorded client/model pairs, never a cross product of two independent lists. */
export function RunClientsCell({
  rows,
  column,
}: {
  rows: Pick<SuiteRunHistoryRow, "client" | "models" | "hostStyle">[];
  column?: "client" | "model";
}) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const mappings = [
    ...new Map(
      rows.map((row) => [
        JSON.stringify([row.client, row.models]),
        {
          client: row.client === "SDK harness" ? "-" : (row.client ?? "-"),
          models: row.models.filter(
            (model) => model.trim() && model.trim().toLowerCase() !== "n/a",
          ),
          hostStyle: row.hostStyle,
        },
      ]),
    ).values(),
  ];
  if (!mappings.length) return <span className="text-muted-foreground">—</span>;

  const entries =
    column === "client"
      ? [
          ...new Map(
            mappings.map((mapping) => [mapping.client, mapping]),
          ).values(),
        ]
      : mappings;
  const visible = entries.slice(0, VISIBLE_RUN_CLIENT_PAIRINGS);
  const hidden = entries.slice(VISIBLE_RUN_CLIENT_PAIRINGS);
  const allLabels = entries.map((mapping) =>
    column === "client" ? mapping.client : pairingLabel(mapping),
  );
  const models = [...new Set(mappings.flatMap((mapping) => mapping.models))];
  // Each column announces ITS OWN values. One shared pairing list made the
  // Client and Model cells read out the same sentence twice per row.
  const columnLabel =
    column === "client"
      ? entries.map((mapping) => mapping.client).join(", ")
      : column === "model"
        ? models.map(compactModelIdTail).join(", ") || "-"
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
            title={models[0]}
          >
            {models[0] ? compactModelIdTail(models[0]) : "-"}
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
                    <li key={model}>{model}</li>
                  ))}
                </ul>
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      )}
      <span
        data-testid={column === "model" ? "expanded-run-models" : undefined}
        className={
          column === "model"
            ? "hidden min-w-0 max-w-80 flex-col items-start gap-2 @min-[1100px]/run-history:flex"
            : // Clients sit on ONE line, the way the suites list shows them.
              // Stacking them made a two-client run twice as tall as a
              // one-client run, so the table's row height read as a result.
              "flex min-w-0 max-w-80 items-center gap-2"
        }
        aria-label={columnLabel}
      >
        {column === "model"
          ? visibleModels.map((model) => (
              <span
                key={model}
                title={model}
                className="min-w-0 truncate text-xs text-muted-foreground"
              >
                {compactModelIdTail(model)}
              </span>
            ))
          : visible.map((mapping, index) => (
              <span
                key={`${mapping.client}-${mapping.models.join(",")}-${index}`}
                // A title, not a tab stop: the span has no role and nothing to
                // activate, and the row already has its own focusable control.
                title={column === "client" ? mapping.client : undefined}
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
                      {mapping.models.map(compactModelIdTail).join(", ") || "-"}
                    </span>
                  )}
                </span>
              </span>
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
                {(column === "model" ? hiddenModels : allLabels).map(
                  (label) => (
                    <li key={label}>{label}</li>
                  ),
                )}
              </ul>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </>
  );
}
