import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAppContext } from "../context";
import { subscribeToList, getTasksByUrgency } from "../subscription";
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
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-sm);
  overflow-x: auto;

  @media (max-width: 1024px) {
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

export function TaskBoard() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const { state, dispatch } = useAppContext();
  const unsubscribersRef = useRef<(() => void)[]>([]);

  // Modal state
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [completeModalOpen, setCompleteModalOpen] = useState(false);
  const [completingTask, setCompletingTask] = useState<Task | null>(null);

  // Get list ID from slug
  const listId = slug ? state.userSlugs[slug] : null;

  // Save last-used list
  useEffect(() => {
    if (slug && listId) {
      appStorage.set(StorageKeys.LAST_LIST, slug);
    }
  }, [slug, listId]);

  useEffect(() => {
    if (!listId || !state.authUser) return;

    // Subscribe to list data
    subscribeToList(listId, state.authUser.uid, dispatch).then((unsubs) => {
      unsubscribersRef.current = unsubs;
    });

    return () => {
      unsubscribersRef.current.forEach((unsub) => unsub());
      unsubscribersRef.current = [];
    };
  }, [listId, state.authUser, dispatch]);

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
  if (slug && state.authUser && !state.loading && !listId) {
    return (
      <Container>
        <NotFoundContainer>
          <h2>List not found</h2>
          <p>The list "{slug}" doesn't exist in your account.</p>
          <button onClick={() => navigate("/")}>Go to My Lists</button>
        </NotFoundContainer>
      </Container>
    );
  }

  // Still loading
  if (state.loading || !state.list) {
    return (
      <Container>
        <Header onAddTask={handleAddTask} />
        <LoadingContainer>
          <Spin size="large" />
        </LoadingContainer>
      </Container>
    );
  }

  const tasksByUrgency = getTasksByUrgency(state);

  return (
    <Container>
      <Header onAddTask={handleAddTask} />
      <BoardContainer>
        <KanbanColumn
          title="Overdue"
          urgency="overdue"
          tasks={tasksByUrgency.overdue}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
        />
        <KanbanColumn
          title="Due Today"
          urgency="today"
          tasks={tasksByUrgency.today}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
        />
        <KanbanColumn
          title="This Week"
          urgency="thisWeek"
          tasks={tasksByUrgency.thisWeek}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
        />
        <KanbanColumn
          title="Later"
          urgency="later"
          tasks={tasksByUrgency.later}
          onEditTask={handleEditTask}
          onCompleteTask={handleCompleteTask}
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
      />
    </Container>
  );
}
