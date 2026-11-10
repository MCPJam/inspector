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
        <SelectTrigger id="compare-pane-select" size="sm" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {panes.map((pane) => (
            <SelectItem key={pane.paneId} value={pane.paneId}>
              {paneName(pane, panes)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
