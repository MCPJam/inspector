import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { compactModelIdTail } from "@/lib/environment-label";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type { SuiteRunHistoryRow } from "../evaluate/suite-detail-model";

export const VISIBLE_RUN_CLIENT_PAIRINGS = 2;

type ClientModelPairing = {
  client: string;
  models: string[];
};

function pairingLabel(mapping: ClientModelPairing): string {
  const models =
    mapping.models.map(compactModelIdTail).join(", ") || "Model not recorded";
  return `${mapping.client} · ${models}`;
}

/** Recorded client/model pairs, never a cross product of two independent lists. */
export function RunClientsCell({ rows }: { rows: SuiteRunHistoryRow[] }) {
  const theme = usePreferencesStoreWithDefaults((state) => state.themeMode);
  const mappings = [
    ...new Map(
      rows.map((row) => [
        JSON.stringify([row.client, row.models]),
        { client: row.client ?? "Unknown client", models: row.models },
      ]),
    ).values(),
  ];
  if (!mappings.length) return <span className="text-muted-foreground">—</span>;

  const visible = mappings.slice(0, VISIBLE_RUN_CLIENT_PAIRINGS);
  const hidden = mappings.slice(VISIBLE_RUN_CLIENT_PAIRINGS);
  const allLabels = mappings.map(pairingLabel);

  const logo = (client: string) => (
    <span className="inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/50 bg-background">
      <img
        src={resolveHostLogoByName(client, theme)}
        alt=""
        className="size-2.5 object-contain"
      />
    </span>
  );

  return (
    <span
      className="flex min-w-0 max-w-80 items-center gap-2"
      aria-label={allLabels.join(", ")}
    >
      {visible.map((mapping, index) => (
        <span
          key={`${mapping.client}-${mapping.models.join(",")}-${index}`}
          className="inline-flex min-w-0 items-center gap-1.5"
        >
          {logo(mapping.client)}
          <span className="truncate text-xs">
            {mapping.client}
            <span className="text-muted-foreground">
              {" "}
              ·{" "}
              {mapping.models.map(compactModelIdTail).join(", ") ||
                "Model not recorded"}
            </span>
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
  );
}
