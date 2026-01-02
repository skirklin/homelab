import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useUpkeepContext } from "../upkeep-context";
import { useAuth } from "@kirkl/shared";
import { getTasksByUrgency } from "../subscription";
import { Header } from "./Header";
import { KanbanColumn } from "./KanbanColumn";
import { TaskModal } from "./TaskModal";
import { CompleteTaskModal } from "./CompleteTaskModal";
import { appStorage, StorageKeys } from "../storage";
import type { Task } from "../types";

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const BoardContainer = styled.main`
  flex: 1;
  padding: var(--space-sm);
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-sm);
  overflow-x: auto;

  @media (max-width: 900px) {
    grid-template-columns: repeat(2, 1fr);
  }

  @media (max-width: 600px) {
    grid-template-columns: 1fr;
  }
`;

const LoadingContainer = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const NotFoundContainer = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--space-xl);
  color: var(--color-text-secondary);
`;

interface TaskBoardProps {
  embedded?: boolean;
}

export function TaskBoard({ embedded = false }: TaskBoardProps) {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { state, setCurrentList } = useUpkeepContext();
  const { user } = useAuth();

  // Modal state
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [completeModalOpen, setCompleteModalOpen] = useState(false);
  const [completingTask, setCompletingTask] = useState<Task | null>(null);
  const [completeModalTab, setCompleteModalTab] = useState<"complete" | "history">("complete");

  // Get list ID from slug
  const listId = slug ? state.userSlugs[slug] : null;

  // Save last-used list and subscribe to list data
  useEffect(() => {
    if (slug && listId) {
      appStorage.set(StorageKeys.LAST_LIST, slug);
      setCurrentList(listId);
    }
  }, [slug, listId, setCurrentList]);

  const handleAddTask = () => {
    setEditingTask(null);
    setTaskModalOpen(true);
  };

  const handleEditTask = (task: Task) => {
    setEditingTask(task);
    setTaskModalOpen(true);
  };

  const handleCompleteTask = (task: Task) => {
    setCompletingTask(task);
    setCompleteModalTab("complete");
    setCompleteModalOpen(true);
  };

  const handleViewHistory = (task: Task) => {
    setCompletingTask(task);
    setCompleteModalTab("history");
    setCompleteModalOpen(true);
  };

  const handleCloseTaskModal = () => {
    setTaskModalOpen(false);
    setEditingTask(null);
  };

  const handleCloseCompleteModal = () => {
    setCompleteModalOpen(false);
    setCompletingTask(null);
  };

  // If slug doesn't exist in user's slugs
  if (slug && user && !state.loading && !listId) {
    return (
      <Container>
        <NotFoundContainer>
          <h2>List not found</h2>
          <p>The list "{slug}" doesn't exist in your account.</p>
          <button onClick={() => navigate("..")}>Go to My Lists</button>
        </NotFoundContainer>
      </Container>
    );
  }

  // Still loading
  if (state.loading || !state.list) {
    return (
      <Container>
        <Header onAddTask={handleAddTask} embedded={embedded} />
        <LoadingContainer>
          <Spin size="large" />
        </LoadingContainer>
      </Container>
    );
  }

  const tasksByUrgency = getTasksByUrgency(state);

  return (
    <Container>
      <Header onAddTask={handleAddTask} embedded={embedded} />
      <BoardContainer>
        <KanbanColumn
          title="Due Today"
          urgency="today"
          tasks={tasksByUrgency.today}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
          onViewHistory={handleViewHistory}
        />
        <KanbanColumn
          title="This Week"
          urgency="thisWeek"
          tasks={tasksByUrgency.thisWeek}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
          onViewHistory={handleViewHistory}
        />
        <KanbanColumn
          title="Later"
          urgency="later"
          tasks={tasksByUrgency.later}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
          onViewHistory={handleViewHistory}
        />
      </BoardContainer>

      <TaskModal
        open={taskModalOpen}
        task={editingTask}
        onClose={handleCloseTaskModal}
      />

      <CompleteTaskModal
        open={completeModalOpen}
        task={completingTask}
        onClose={handleCloseCompleteModal}
        initialTab={completeModalTab}
      />
    </Container>
  );
}
