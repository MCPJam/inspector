import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { SortablePane } from "./SortablePane";
import { getPane } from "./registry";
import type { PaneId, PaneSide } from "./types";

interface PaneSlotProps {
  side: PaneSide;
  paneIds: PaneId[];
  onClosePane: (paneId: PaneId) => void;
}

/**
 * A vertical column of stacked `SortablePane`s on either the left or right of
 * the Playground IDE shell. Wraps the panes in a `SortableContext` so that
 * `@dnd-kit/core`'s `DndContext` higher up the tree can move panes within and
 * across slots (left ↔ right) under a single drag operation.
 *
 * The `PlaygroundTab` owns the `DndContext` and the cross-slot reorder logic;
 * this component is just a layout primitive.
 */
export function PaneSlot({ side, paneIds, onClosePane }: PaneSlotProps) {
  // Skip ids that aren't in the registry — saved views may reference panes
  // that have been renamed or removed. Don't crash on stale payloads.
  const visiblePanes = paneIds
    .map((id) => getPane(id))
    .filter((pane): pane is NonNullable<ReturnType<typeof getPane>> =>
      Boolean(pane),
    );

  if (visiblePanes.length === 0) return null;

  const containerId = `playground-pane-slot-${side}`;
  const sortableItems = visiblePanes.map((pane) => pane.id);

  return (
    <SortableContext
      id={containerId}
      items={sortableItems}
      strategy={verticalListSortingStrategy}
    >
      <div
        className="flex h-full min-h-0 flex-col overflow-hidden"
        data-pane-slot={side}
      >
        {visiblePanes.map((pane) => (
          <SortablePane
            key={pane.id}
            id={pane.id}
            title={pane.title}
            icon={pane.icon}
            onClose={() => onClosePane(pane.id)}
          >
            {pane.renderBody({ side, onClose: () => onClosePane(pane.id) })}
          </SortablePane>
        ))}
      </div>
    </SortableContext>
  );
}
