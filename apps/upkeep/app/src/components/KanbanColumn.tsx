import styled from "styled-components";
import { TaskCard } from "./TaskCard";
import type { Task } from "../types";

/**
 * The Kanban board is recurring-only and renders exactly three columns. There
 * is no "asap" column — only one-shot todos can be overdue/someday, which the
 * `Task` union now keeps off this board entirely.
 */
type ColumnKind = "today" | "thisWeek" | "later";

const urgencyStyles: Record<ColumnKind, { bg: string; border: string; headerColor: string }> = {
  today: {
    bg: "var(--color-today-bg)",
    border: "var(--color-today)",
    headerColor: "var(--color-today)",
  },
  thisWeek: {
    bg: "var(--color-this-week-bg)",
    border: "var(--color-this-week)",
    headerColor: "var(--color-this-week)",
  },
  later: {
    bg: "var(--color-later-bg)",
    border: "var(--color-later)",
    headerColor: "var(--color-later)",
  },
};

const Column = styled.div<{ $urgency: ColumnKind }>`
  background: ${(props) => urgencyStyles[props.$urgency].bg};
  border: 2px solid ${(props) => urgencyStyles[props.$urgency].border};
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  min-height: 300px;

  /* Only cap column height on the side-by-side desktop layout so each
     column gets its own scroller. On mobile (single-column stack from
     TaskBoard's grid), let the page scroll naturally — a per-column
     scroller capped at 100dvh fights the page scroll and intermittently
     traps touch on iOS Safari as the address bar resizes the viewport. */
  @media (min-width: 601px) {
    max-height: calc(100vh - 140px);
    max-height: calc(100dvh - 140px);
  }
`;

const ColumnHeader = styled.div<{ $urgency: ColumnKind }>`
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid ${(props) => urgencyStyles[props.$urgency].border};
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const ColumnTitle = styled.h2<{ $urgency: ColumnKind }>`
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: 600;
  color: ${(props) => urgencyStyles[props.$urgency].headerColor};
`;

const TaskCount = styled.span<{ $urgency: ColumnKind }>`
  background: ${(props) => urgencyStyles[props.$urgency].border};
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: var(--font-size-xs);
  font-weight: 600;
`;

const TaskList = styled.div`
  flex: 1;
  padding: var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);

  /* Inner scroller only exists on desktop where the Column is height-capped.
     On mobile the column grows to its content height and the page scrolls. */
  @media (min-width: 601px) {
    overflow-y: auto;
  }
`;

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  padding: var(--space-lg);
  text-align: center;
`;

interface KanbanColumnProps {
  title: string;
  urgency: ColumnKind;
  tasks: Task[];
  onEditTask: (task: Task) => void;
  onCompleteTask: (task: Task) => void;
  onViewHistory: (task: Task) => void;
}

export function KanbanColumn({ title, urgency, tasks, onEditTask, onCompleteTask, onViewHistory }: KanbanColumnProps) {
  return (
    <Column $urgency={urgency}>
      <ColumnHeader $urgency={urgency}>
        <ColumnTitle $urgency={urgency}>{title}</ColumnTitle>
        {tasks.length > 0 && (
          <TaskCount $urgency={urgency}>{tasks.length}</TaskCount>
        )}
      </ColumnHeader>
      {tasks.length === 0 ? (
        <EmptyState>No tasks</EmptyState>
      ) : (
        <TaskList>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              onEdit={() => onEditTask(task)}
              onComplete={() => onCompleteTask(task)}
              onViewHistory={() => onViewHistory(task)}
            />
          ))}
        </TaskList>
      )}
    </Column>
  );
}
