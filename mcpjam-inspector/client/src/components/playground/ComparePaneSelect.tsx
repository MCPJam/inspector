import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Badge } from "@mcpjam/design-system/badge";
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
                className="min-h-12"
                description={pane.modelName}
                leading={
                  <img
                    src={pane.logoSrc ?? UNKNOWN_HOST_LOGO}
                    alt=""
                    className="size-5 shrink-0 object-contain"
                  />
                }
                trailing={
                  pane.serverSummary && (
                    <Badge variant="outline">{pane.serverSummary}</Badge>
                  )
                }
              >
                {name}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
