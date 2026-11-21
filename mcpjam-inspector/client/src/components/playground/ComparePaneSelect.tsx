import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  useComparePaneStore,
  type ComparePaneOption,
} from "@/stores/compare-pane-store";
import { UNKNOWN_HOST_LOGO } from "@/lib/host-logo";

/** Names a pane by its client, and by position when two panes share one. */
function paneName(pane: ComparePaneOption, panes: ComparePaneOption[]) {
  const index = panes.indexOf(pane);
  const shared = panes.filter((entry) => entry.label === pane.label).length > 1;
  return shared ? `${pane.label} (${index + 1})` : pane.label;
}

/** Which Compare pane the Tools sidebar shows. */
export function ComparePaneSelect({
  selected,
}: {
  selected: ComparePaneOption;
}) {
  const panes = useComparePaneStore((state) => state.panes);
  const selectPane = useComparePaneStore((state) => state.selectPane);
  return (
    <div className="space-y-1.5 border-b border-border px-3 py-2">
      <label
        htmlFor="compare-pane-select"
        className="text-xs font-medium text-foreground"
      >
        Pane
      </label>
      <Select value={selected.paneId} onValueChange={selectPane}>
        <SelectTrigger
          id="compare-pane-select"
          size="sm"
          className="w-full *:data-[slot=select-value]:min-w-0"
        >
          <SelectValue>
            <img
              src={selected.logoSrc ?? UNKNOWN_HOST_LOGO}
              alt=""
              className="size-4 shrink-0 object-contain"
            />
            <span className="truncate">{paneName(selected, panes)}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {panes.map((pane) => {
            const name = paneName(pane, panes);
            return (
              <SelectItem
                key={pane.paneId}
                value={pane.paneId}
                textValue={name}
                className="min-h-12 data-[state=checked]:bg-accent/60 [&>span:last-child]:min-w-0 [&>span:last-child]:flex-1"
              >
                <img
                  src={pane.logoSrc ?? UNKNOWN_HOST_LOGO}
                  alt=""
                  className="size-5 shrink-0 object-contain"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-medium" title={name}>
                    {name}
                  </span>
                  {pane.modelName && (
                    <span
                      className="truncate text-xs text-muted-foreground"
                      title={pane.modelName}
                    >
                      {pane.modelName}
                    </span>
                  )}
                </span>
                {pane.serverSummary && (
                  <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                    {pane.serverSummary}
                  </span>
                )}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
