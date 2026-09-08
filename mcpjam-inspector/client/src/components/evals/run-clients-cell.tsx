import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { resolveHostLogoByName } from "@/lib/host-logo";
import { compactModelIdTail } from "@/lib/environment-label";
import { usePreferencesStoreWithDefaults } from "@/stores/preferences/preferences-provider";
import type { SuiteRunHistoryRow } from "../evaluate/suite-detail-model";

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
  const clients = [...new Set(mappings.map((mapping) => mapping.client))];
  const modelLabel = (models: string[]) =>
    models.map(compactModelIdTail).join(", ") || "Model not recorded";
  const logo = (client: string) => (
    <span className="inline-flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border/50 bg-background ring-1 ring-background">
      <img
        src={resolveHostLogoByName(client, theme)}
        alt=""
        className="size-3.5 object-contain"
      />
    </span>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex max-w-64 items-center gap-2 rounded-md text-left outline-offset-4 hover:text-foreground focus-visible:outline-ring"
          aria-label={`Client model mapping: ${clients.join(", ")}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <span className="flex shrink-0 -space-x-1.5">
            {clients.slice(0, 3).map((client) => (
              <span key={client}>{logo(client)}</span>
            ))}
            {clients.length > 3 && (
              <span className="inline-flex size-6 items-center justify-center rounded-md border bg-background text-[10px]">
                +{clients.length - 3}
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-xs">{clients.join(", ")}</span>
            <span className="block truncate text-[10px] text-muted-foreground">
              {mappings.length === 1
                ? modelLabel(mappings[0].models)
                : `${mappings.length} client : model pairings`}
            </span>
          </span>
          <ChevronDown
            className="size-3 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-3"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <p className="mb-3 text-xs font-semibold">Client : model</p>
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {mappings.map((mapping, index) => (
            <div key={index} className="flex items-start gap-2 text-xs">
              {logo(mapping.client)}
              <div className="min-w-0">
                <p className="font-medium">{mapping.client}</p>
                <p className="break-words text-muted-foreground">
                  {mapping.models.join(", ") || "Model not recorded"}
                </p>
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
