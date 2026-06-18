/**
 * Touch-friendly sortable list primitives for the habit board's "Reorder" edit
 * mode, built on @dnd-kit (already vendored in the monorepo for shopping/travel).
 *
 * `SortableList` wraps a group of rows in a vertical drag context; `SortableRow`
 * renders one draggable row with a left-edge drag handle. dnd-kit's PointerSensor
 * (with a small activation distance) makes press-and-drag work on touch without a
 * long-press, which is what Angela needs on mobile. The handle is the ONLY drag
 * affordance, so the rest of a row stays inert in edit mode.
 *
 * The list is generic over a string id; `onReorder` receives the full reordered
 * id list (a permutation), matching the `reorderGoals` / `reorderTrackables`
 * backend ops which expect a complete permutation.
 */
import type { ReactNode } from "react";
import styled from "styled-components";
import { HolderOutlined } from "@ant-design/icons";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const Handle = styled.button`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  align-self: stretch;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  color: var(--color-text-secondary);
  cursor: grab;
  touch-action: none; /* let dnd-kit's PointerSensor own the gesture on touch */
  font-size: 18px;

  &:active { cursor: grabbing; }
`;

const RowWrap = styled.div<{ $dragging: boolean }>`
  display: flex;
  align-items: stretch;
  gap: var(--space-xs);
  opacity: ${(p) => (p.$dragging ? 0.6 : 1)};
`;

const RowBody = styled.div`
  flex: 1;
  min-width: 0;
`;

export interface SortableListProps {
  /** The ordered ids currently rendered (one per child row). */
  ids: string[];
  /** Called with the FULL reordered id list after a drag settles. */
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}

/** A vertical sortable context. Children must be `<SortableRow>`s, in `ids` order. */
export function SortableList({ ids, onReorder, children }: SortableListProps) {
  // A 6px activation distance lets a tap-with-tiny-movement still settle as a tap
  // (no accidental drags) while a deliberate drag starts immediately — no
  // long-press delay, which matters for a fluid mobile reorder.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    onReorder(arrayMove(ids, from, to));
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface SortableRowProps {
  id: string;
  children: ReactNode;
}

/** One draggable row: a drag handle on the left, the row body on the right. */
export function SortableRow({ id, children }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <RowWrap ref={setNodeRef} style={style} $dragging={isDragging} data-testid="sortable-row" data-id={id}>
      <Handle
        type="button"
        aria-label="Drag to reorder"
        data-testid="drag-handle"
        {...attributes}
        {...listeners}
      >
        <HolderOutlined aria-hidden />
      </Handle>
      <RowBody>{children}</RowBody>
    </RowWrap>
  );
}
