import { createContext, useContext, type ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
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
  return (
    <DragEnabled.Provider value={!disabled}>
      <DndContext
        sensors={sensors}
        collisionDetection={compatibleRows}
        onDragEnd={onReorder}
      >
        <SortableContext items={items}>{children}</SortableContext>
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
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, data: { phase, kind }, disabled: !enabled });
  return {
    rowProps: {
      ref: setNodeRef,
      style: {
        transform: CSS.Transform.toString(transform),
        transition,
        position: isDragging ? ("relative" as const) : undefined,
        zIndex: isDragging ? 20 : undefined,
        opacity: isDragging ? 0.7 : undefined,
      },
    },
    handle: enabled
      ? (label: string) => (
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
        )
      : () => null,
  };
}
