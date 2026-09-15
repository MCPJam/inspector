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
  const models =
    mapping.models.map(compactModelIdTail).join(", ") || "Model not recorded";
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
          client: row.client ?? "Suite default",
          models: row.models,
          hostStyle: row.hostStyle,
        },
      ]),
    ).values(),
  ];
  if (!mappings.length) return <span className="text-muted-foreground">—</span>;

  const visible = mappings.slice(0, VISIBLE_RUN_CLIENT_PAIRINGS);
  const hidden = mappings.slice(VISIBLE_RUN_CLIENT_PAIRINGS);
  const allLabels = mappings.map(pairingLabel);
  const models = [...new Set(mappings.flatMap((mapping) => mapping.models))];

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
            {models[0] ? compactModelIdTail(models[0]) : "Model not recorded"}
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
            : column
              ? "flex min-w-0 max-w-80 flex-col items-start gap-2"
              : "flex min-w-0 max-w-80 items-center gap-2"
        }
        aria-label={allLabels.join(", ")}
      >
        {visible.map((mapping, index) => (
          <span
            key={`${mapping.client}-${mapping.models.join(",")}-${index}`}
            title={column === "client" ? mapping.client : undefined}
            tabIndex={column === "client" ? 0 : undefined}
            className="inline-flex min-w-0 items-center gap-1.5"
          >
            {column !== "model" && logo(mapping.client, mapping.hostStyle)}
            <span
              className={
                column === "client"
                  ? "hidden truncate text-xs @min-[1100px]/run-history:inline"
                  : "truncate text-xs"
              }
            >
              {column !== "model" && mapping.client}
              {column !== "client" && (
                <span className="text-muted-foreground">
                  {!column && " · "}
                  {mapping.models.map(compactModelIdTail).join(", ") ||
                    "Model not recorded"}
                </span>
              )}
            </span>
          </span>
        ))}
        {hidden.length > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={0}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="inline-flex h-5 shrink-0 items-center rounded-sm px-1 text-[10px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:outline-ring"
                aria-label={`${hidden.length} more client and model pairings`}
              >
                +{hidden.length}
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
                {allLabels.map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </>
  );
}
