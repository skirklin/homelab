import { useState, useEffect } from "react";
import styled from "styled-components";
import { Spin, Empty, Tag } from "antd";
import {
  CheckCircleOutlined,
  HeartOutlined,
  ExperimentOutlined,
} from "@ant-design/icons";
import { useAuth, db } from "@kirkl/shared";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  getDoc,
  Timestamp,
} from "firebase/firestore";

const Container = styled.div`
  max-width: 600px;
  margin: 0 auto;
  padding: var(--space-md);
`;

const Title = styled.h1`
  font-size: var(--font-size-xl);
  margin: 0 0 var(--space-lg) 0;
  color: var(--color-text);
`;

const LoadingContainer = styled.div`
  display: flex;
  justify-content: center;
  padding: var(--space-xl);
`;

const TimelineList = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
`;

const EventCard = styled.div`
  display: flex;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
`;

const EventIcon = styled.div<{ $color: string }>`
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: ${(props) => props.$color}20;
  color: ${(props) => props.$color};
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
`;

const EventContent = styled.div`
  flex: 1;
  min-width: 0;
`;

const EventHeader = styled.div`
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-xs);
`;

const EventTitle = styled.span`
  font-weight: 500;
  color: var(--color-text);
`;

const EventTime = styled.span`
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
`;

const EventNote = styled.p`
  margin: var(--space-xs) 0 0 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-style: italic;
`;

const DateHeader = styled.div`
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: var(--space-md) 0 var(--space-sm) 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;

  &:first-child {
    margin-top: 0;
  }
`;

interface TimelineEvent {
  id: string;
  type: "recipe" | "life" | "upkeep";
  subjectId: string;
  subjectName?: string;
  timestamp: Date;
  createdBy: string;
  data: Record<string, unknown>;
  containerId: string;
}

// Event type configurations
const eventConfig = {
  recipe: {
    icon: <ExperimentOutlined />,
    color: "#f59e0b",
    label: "Cooked",
  },
  life: {
    icon: <HeartOutlined />,
    color: "#ec4899",
    label: "Logged",
  },
  upkeep: {
    icon: <CheckCircleOutlined />,
    color: "#10b981",
    label: "Completed",
  },
};

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(date: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  if (eventDate.getTime() === today.getTime()) {
    return "Today";
  }
  if (eventDate.getTime() === yesterday.getTime()) {
    return "Yesterday";
  }
  return date.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function groupEventsByDate(events: TimelineEvent[]): Map<string, TimelineEvent[]> {
  const groups = new Map<string, TimelineEvent[]>();
  for (const event of events) {
    const dateKey = new Date(
      event.timestamp.getFullYear(),
      event.timestamp.getMonth(),
      event.timestamp.getDate()
    ).toISOString();
    const existing = groups.get(dateKey) || [];
    existing.push(event);
    groups.set(dateKey, existing);
  }
  return groups;
}

export function Timeline() {
  const { user } = useAuth();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [subjectNames, setSubjectNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!user) return;

    const fetchEvents = async () => {
      setLoading(true);
      const allEvents: TimelineEvent[] = [];
      const names = new Map<string, string>();

      try {
        // Fetch all containers in parallel
        const [boxesSnapshot, lifeLogsSnapshot, taskListsSnapshot] = await Promise.all([
          getDocs(query(collection(db, "boxes"), where("owners", "array-contains", user.uid))),
          getDocs(query(collection(db, "lifeLogs"), where("owners", "array-contains", user.uid))),
          getDocs(query(collection(db, "taskLists"), where("owners", "array-contains", user.uid))),
        ]);

        // Store widget labels from life logs (already in the container doc)
        const widgetLabels = new Map<string, string>();
        for (const logDoc of lifeLogsSnapshot.docs) {
          const widgets = logDoc.data().manifest?.widgets || [];
          for (const w of widgets) {
            widgetLabels.set(w.id, w.label);
          }
        }

        // Phase 1: Fetch all events in parallel (no name lookups yet)
        const eventQueries: Promise<void>[] = [];

        // Recipe events
        for (const boxDoc of boxesSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "boxes", boxDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(20)
              ));

              for (const eventDoc of eventsSnapshot.docs) {
                const data = eventDoc.data();
                allEvents.push({
                  id: eventDoc.id,
                  type: "recipe",
                  subjectId: data.subjectId,
                  timestamp: (data.timestamp as Timestamp).toDate(),
                  createdBy: data.createdBy,
                  data: data.data || {},
                  containerId: boxDoc.id,
                });
              }
            })()
          );
        }

        // Life tracker events (unified events collection)
        for (const logDoc of lifeLogsSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "lifeLogs", logDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(20)
              ));

              for (const eventDoc of eventsSnapshot.docs) {
                const data = eventDoc.data();
                allEvents.push({
                  id: eventDoc.id,
                  type: "life",
                  subjectId: data.subjectId,
                  subjectName: widgetLabels.get(data.subjectId) || data.subjectId,
                  timestamp: (data.timestamp as Timestamp).toDate(),
                  createdBy: data.createdBy,
                  data: data.data || {},
                  containerId: logDoc.id,
                });
              }
            })()
          );
        }

        // Upkeep events (unified events collection)
        for (const listDoc of taskListsSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "taskLists", listDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(20)
              ));

              for (const eventDoc of eventsSnapshot.docs) {
                const data = eventDoc.data();
                allEvents.push({
                  id: eventDoc.id,
                  type: "upkeep",
                  subjectId: data.subjectId,
                  timestamp: (data.timestamp as Timestamp).toDate(),
                  createdBy: data.createdBy,
                  data: data.data || {},
                  containerId: listDoc.id,
                });
              }
            })()
          );
        }

        await Promise.all(eventQueries);

        // Phase 2: Fetch only the specific names we need
        const recipeIds = new Set<string>();
        const taskIds = new Map<string, string>(); // taskId -> containerId

        for (const event of allEvents) {
          if (event.type === "recipe") {
            recipeIds.add(`${event.containerId}/${event.subjectId}`);
          } else if (event.type === "upkeep" && !event.subjectName) {
            taskIds.set(event.subjectId, event.containerId);
          }
        }

        // Fetch recipe names (only the ones we need)
        const nameQueries: Promise<void>[] = [];
        for (const key of recipeIds) {
          const [boxId, recipeId] = key.split("/");
          nameQueries.push(
            (async () => {
              const recipeDoc = await getDoc(doc(db, "boxes", boxId, "recipes", recipeId));
              if (recipeDoc.exists()) {
                names.set(recipeId, recipeDoc.data().data?.name || "Recipe");
              }
            })()
          );
        }

        // Fetch task names (only the ones we need)
        for (const [taskId, listId] of taskIds) {
          nameQueries.push(
            (async () => {
              const taskDoc = await getDoc(doc(db, "taskLists", listId, "tasks", taskId));
              if (taskDoc.exists()) {
                names.set(taskId, taskDoc.data().name || "Task");
              }
            })()
          );
        }

        await Promise.all(nameQueries);

        // Apply names to events
        for (const event of allEvents) {
          if (!event.subjectName && names.has(event.subjectId)) {
            event.subjectName = names.get(event.subjectId);
          }
        }

        setSubjectNames(names);

        // Sort all events by timestamp descending
        allEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        setEvents(allEvents.slice(0, 100));
      } catch (error) {
        console.error("Failed to fetch timeline:", error);
      } finally {
        setLoading(false);
      }
    };

    fetchEvents();
  }, [user]);

  if (loading) {
    return (
      <Container>
        <Title>Timeline</Title>
        <LoadingContainer>
          <Spin size="large" />
        </LoadingContainer>
      </Container>
    );
  }

  if (events.length === 0) {
    return (
      <Container>
        <Title>Timeline</Title>
        <Empty description="No events yet" />
      </Container>
    );
  }

  const groupedEvents = groupEventsByDate(events);

  return (
    <Container>
      <Title>Timeline</Title>
      <TimelineList>
        {Array.from(groupedEvents.entries()).map(([dateKey, dayEvents]) => (
          <div key={dateKey}>
            <DateHeader>{formatDateHeader(new Date(dateKey))}</DateHeader>
            {dayEvents.map((event) => {
              const config = eventConfig[event.type];
              const name =
                event.subjectName || subjectNames.get(event.subjectId) || event.subjectId;
              const notes = event.data.notes as string | undefined;

              return (
                <EventCard key={`${event.type}-${event.id}`}>
                  <EventIcon $color={config.color}>{config.icon}</EventIcon>
                  <EventContent>
                    <EventHeader>
                      <Tag color={config.color}>{config.label}</Tag>
                      <EventTitle>{name}</EventTitle>
                      <EventTime>{formatTime(event.timestamp)}</EventTime>
                    </EventHeader>
                    {notes && <EventNote>"{notes}"</EventNote>}
                  </EventContent>
                </EventCard>
              );
            })}
          </div>
        ))}
      </TimelineList>
    </Container>
  );
}
