import styled from "styled-components";
import { TaskCard } from "./TaskCard";
import type { Task, UrgencyLevel } from "../types";

const urgencyStyles = {
  overdue: {
    bg: "var(--color-overdue-bg)",
    border: "var(--color-overdue)",
    headerColor: "var(--color-overdue)",
  },
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

const Column = styled.div<{ $urgency: UrgencyLevel }>`
  background: ${(props) => urgencyStyles[props.$urgency].bg};
  border: 2px solid ${(props) => urgencyStyles[props.$urgency].border};
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  min-height: 300px;
  max-height: calc(100vh - 140px);
`;

const ColumnHeader = styled.div<{ $urgency: UrgencyLevel }>`
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid ${(props) => urgencyStyles[props.$urgency].border};
  display: flex;
  align-items: center;
  justify-content: space-between;
`;

const ColumnTitle = styled.h2<{ $urgency: UrgencyLevel }>`
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: 600;
  color: ${(props) => urgencyStyles[props.$urgency].headerColor};
`;

const TaskCount = styled.span<{ $urgency: UrgencyLevel }>`
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
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
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
  urgency: UrgencyLevel;
  tasks: Task[];
  onEditTask: (task: Task) => void;
  onCompleteTask: (task: Task) => void;
}

export function KanbanColumn({ title, urgency, tasks, onEditTask, onCompleteTask }: KanbanColumnProps) {
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
            />
          ))}
        </TaskList>
      )}
    </Column>
  );
}
