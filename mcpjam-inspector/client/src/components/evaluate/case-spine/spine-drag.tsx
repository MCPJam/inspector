import {
  createContext,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

type DragPhase = "steps" | "case";
const DragEnabled = createContext(false);
const compatibleRows: CollisionDetection = (args) => {
  const data = args.active.data.current;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) =>
        container.data.current?.phase === data?.phase &&
        container.data.current?.kind === data?.kind,
    ),
  });
};
const compatibleKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  args,
) => {
  const { active, droppableContainers, droppableRects } = args.context;
  const data = active?.data.current;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: {
      ...args.context,
      droppableRects: new Map(
        [...droppableRects].filter(([id]) => {
          const target = droppableContainers.get(id)?.data.current;
          return target?.phase === data?.phase && target?.kind === data?.kind;
        }),
      ),
    },
  });
};
export function SpineDragProvider({
  items,
  disabled,
  onReorder,
  children,
}: {
  items: string[];
  disabled: boolean;
  onReorder: (event: DragEndEvent) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: compatibleKeyboardCoordinates,
    }),
  );
  // A light preview follows the pointer while the real row stays in the
  // list as a placeholder — same pattern as the Servers grid.
  const [preview, setPreview] = useState<{
    label: string;
    width: number;
  } | null>(null);
  const onDragStart = (event: DragStartEvent) => {
    const getLabel = event.active.data.current?.getLabel as
      (() => string) | undefined;
    setPreview({
      label: getLabel?.() ?? "",
      width: event.active.rect.current.initial?.width ?? 0,
    });
  };
  return (
    <DragEnabled.Provider value={!disabled}>
      <DndContext
        sensors={sensors}
        collisionDetection={compatibleRows}
        onDragStart={onDragStart}
        onDragEnd={(event) => {
          setPreview(null);
          onReorder(event);
        }}
        onDragCancel={() => setPreview(null)}
      >
        <SortableContext items={items} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
        <DragOverlay>
          {preview ? (
            <div
              style={{ width: preview.width || undefined }}
              className="flex items-center gap-2 rounded-md border border-border bg-card py-2.5 pl-1.5 pr-4 text-sm font-medium shadow-md cursor-grabbing"
            >
              <GripVertical
                aria-hidden
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="truncate">{preview.label}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </DragEnabled.Provider>
  );
}

export function useSpineDrag({
  id,
  phase,
  kind,
  disabled = false,
}: {
  id: string;
  phase: DragPhase;
  kind: "assert" | "action";
  disabled?: boolean;
}) {
  const enabled = useContext(DragEnabled) && !disabled;
  // Filled in by `handle(label)` so the drag preview can name the row.
  const labelRef = useRef("");
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id,
    data: { phase, kind, getLabel: () => labelRef.current },
    disabled: !enabled,
  });
  return {
    rowProps: {
      ref: setNodeRef,
      style: {
        // Translate, not Transform: Transform also scales the row to the
        // size of the row it passes over, which squashes its contents.
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : undefined,
      },
    },
    handle: enabled
      ? (label: string) => {
          labelRef.current = label;
          return (
            <button
              type="button"
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              aria-label={`Drag ${label}`}
              title="Drag to reorder"
              className="absolute left-1.5 top-2.5 flex size-6 touch-none items-center justify-center rounded-sm text-muted-foreground cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-ring"
            >
              <GripVertical aria-hidden className="size-4" />
            </button>
          );
        }
      : () => null,
  };
}
