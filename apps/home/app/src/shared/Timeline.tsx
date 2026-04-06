import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import styled from "styled-components";
import { Spin, Empty, Tag } from "antd";
import {
  CheckCircleOutlined,
  HeartOutlined,
  ExperimentOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useAuth, db } from "@kirkl/shared";
import { useRecipesContext } from "@kirkl/recipes";
import { useUpkeepContext } from "@kirkl/upkeep";
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

interface UserProfile {
  householdSlugs?: Record<string, string>;
}

// Module-level cache to prevent double-fetch from StrictMode
const timelineCache = {
  fetching: false,
  userId: null as string | null,
  events: null as TimelineEvent[] | null,
  slugMap: null as Map<string, string> | null,
};

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

const EventCard = styled.div<{ $clickable?: boolean }>`
  display: flex;
  gap: var(--space-md);
  padding: var(--space-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: ${(props) => (props.$clickable ? "pointer" : "default")};
  transition: background 0.15s, border-color 0.15s;

  ${(props) =>
    props.$clickable &&
    `
    &:hover {
      background: var(--color-bg-muted);
      border-color: var(--color-primary);
    }
  `}
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

const EventArrow = styled.div`
  display: flex;
  align-items: center;
  color: var(--color-text-secondary);
  font-size: 12px;
  flex-shrink: 0;
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
  const navigate = useNavigate();
  const { state: recipesState } = useRecipesContext();
  const { state: upkeepState } = useUpkeepContext();
  const [events, setEvents] = useState<TimelineEvent[]>(() => timelineCache.events || []);
  const [loading, setLoading] = useState(() => !timelineCache.events);
  const [subjectNames, setSubjectNames] = useState<Map<string, string>>(new Map());
  const [upkeepSlugMap, setUpkeepSlugMap] = useState<Map<string, string>>(() => timelineCache.slugMap || new Map());

  // Build recipe name lookup from recipes context (already loaded by RecipesProvider)
  const recipeNames = useMemo(() => {
    const names = new Map<string, string>();
    // Recipes are nested inside boxes: boxes -> box.recipes
    for (const box of recipesState.boxes.values()) {
      for (const [recipeId, recipe] of box.recipes) {
        const name = recipe.data?.name;
        if (name && typeof name === "string") {
          names.set(recipeId, name);
        }
      }
    }
    return names;
  }, [recipesState.boxes]);

  // Build task name lookup from upkeep context
  const taskNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const [taskId, task] of upkeepState.tasks) {
      if (task.name) {
        names.set(taskId, task.name);
      }
    }
    return names;
  }, [upkeepState.tasks]);

  useEffect(() => {
    if (!user) return;

    // Use cached data if available for this user
    if (timelineCache.userId === user.uid && timelineCache.events) {
      return;
    }

    // Prevent concurrent fetches (React StrictMode double-invokes effects)
    if (timelineCache.fetching) return;
    timelineCache.fetching = true;

    const fetchEvents = async () => {
      setLoading(true);
      const allEvents: TimelineEvent[] = [];
      const startTime = performance.now();

      try {
        // Phase 1: Fetch user profile AND containers in parallel
        const [userProfileDoc, boxesSnapshot, lifeLogsSnapshot, taskListsSnapshot] = await Promise.all([
          getDoc(doc(db, "users", user.uid)),
          getDocs(query(collection(db, "boxes"), where("owners", "array-contains", user.uid), limit(10))),
          getDocs(query(collection(db, "lifeLogs"), where("owners", "array-contains", user.uid), limit(5))),
          getDocs(query(collection(db, "taskLists"), where("owners", "array-contains", user.uid), limit(5))),
        ]);
        console.log(`Timeline: phase 1 took ${(performance.now() - startTime).toFixed(0)}ms - found ${boxesSnapshot.size} boxes, ${lifeLogsSnapshot.size} lifeLogs, ${taskListsSnapshot.size} taskLists`);

        // Process user profile for slug mappings
        if (userProfileDoc.exists()) {
          const profile = userProfileDoc.data() as UserProfile;
          if (profile.householdSlugs) {
            const slugMap = new Map<string, string>();
            for (const [slug, listId] of Object.entries(profile.householdSlugs)) {
              slugMap.set(listId, slug);
            }
            setUpkeepSlugMap(slugMap);
            timelineCache.slugMap = slugMap;
          }
        }

        // Store widget labels from life logs (already in the container doc)
        const widgetLabels = new Map<string, string>();
        for (const logDoc of lifeLogsSnapshot.docs) {
          const widgets = logDoc.data().manifest?.widgets || [];
          for (const w of widgets) {
            widgetLabels.set(w.id, w.label);
          }
        }

        // Phase 2: Fetch all events in parallel
        const phase2Start = performance.now();
        const eventQueries: Promise<void>[] = [];

        // Recipe events
        for (const boxDoc of boxesSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "boxes", boxDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(15)
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

        // Life tracker events
        for (const logDoc of lifeLogsSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "lifeLogs", logDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(15)
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

        // Upkeep events
        for (const listDoc of taskListsSnapshot.docs) {
          eventQueries.push(
            (async () => {
              const eventsSnapshot = await getDocs(query(
                collection(db, "taskLists", listDoc.id, "events"),
                where("createdBy", "==", user.uid),
                orderBy("timestamp", "desc"),
                limit(15)
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
        console.log(`Timeline: phase 2 took ${(performance.now() - phase2Start).toFixed(0)}ms - fetched ${allEvents.length} events`);

        // Sort events
        allEvents.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        const topEvents = allEvents.slice(0, 100);

        // Apply names from context immediately (no network needed)
        for (const event of topEvents) {
          if (event.type === "recipe" && !event.subjectName) {
            const name = recipeNames.get(event.subjectId);
            if (name) event.subjectName = name;
          } else if (event.type === "upkeep" && !event.subjectName) {
            const name = taskNames.get(event.subjectId);
            if (name) event.subjectName = name;
          }
        }

        setEvents(topEvents);
        setLoading(false);

        // Update cache
        timelineCache.userId = user.uid;
        timelineCache.events = topEvents;
        timelineCache.fetching = false;
        console.log(`Timeline: total ${(performance.now() - startTime).toFixed(0)}ms - applied ${recipeNames.size} recipe names, ${taskNames.size} task names from context`);

        // Phase 3: Only fetch names we couldn't find in context
        const missingRecipes: string[] = [];
        const missingTasks: Array<[string, string]> = [];

        for (const event of topEvents) {
          if (event.type === "recipe" && !event.subjectName && missingRecipes.length < 5) {
            const key = `${event.containerId}/${event.subjectId}`;
            if (!missingRecipes.includes(key)) {
              missingRecipes.push(key);
            }
          } else if (event.type === "upkeep" && !event.subjectName && missingTasks.length < 5) {
            if (!missingTasks.some(([id]) => id === event.subjectId)) {
              missingTasks.push([event.subjectId, event.containerId]);
            }
          }
        }

        // Only make network requests if we have missing names
        if (missingRecipes.length > 0 || missingTasks.length > 0) {
          setTimeout(async () => {
            const names = new Map<string, string>();

            const queries = [
              ...missingRecipes.map(async (key) => {
                const [boxId, recipeId] = key.split("/");
                try {
                  const recipeDoc = await getDoc(doc(db, "boxes", boxId, "recipes", recipeId));
                  if (recipeDoc.exists()) {
                    names.set(recipeId, recipeDoc.data().data?.name || "Recipe");
                  }
                } catch { /* ignore */ }
              }),
              ...missingTasks.map(async ([taskId, listId]) => {
                try {
                  const taskDoc = await getDoc(doc(db, "taskLists", listId, "tasks", taskId));
                  if (taskDoc.exists()) {
                    names.set(taskId, taskDoc.data().name || "Task");
                  }
                } catch { /* ignore */ }
              }),
            ];

            await Promise.all(queries);

            if (names.size > 0) {
              setSubjectNames(prev => new Map([...prev, ...names]));
              setEvents(prevEvents => prevEvents.map(event => ({
                ...event,
                subjectName: event.subjectName || names.get(event.subjectId),
              })));
            }
          }, 50);
        }
      } catch (error) {
        console.error("Failed to fetch timeline:", error);
        setLoading(false);
        timelineCache.fetching = false;
      }
    };

    fetchEvents();

    return () => {
      // Don't reset cache - it survives component unmount/remount
    };
  }, [user]);

  // Re-apply names when context data becomes available
  useEffect(() => {
    if (events.length === 0) return;
    if (recipeNames.size === 0 && taskNames.size === 0) return;

    let updated = false;
    const updatedEvents = events.map(event => {
      if (!event.subjectName) {
        const name = event.type === "recipe"
          ? recipeNames.get(event.subjectId)
          : event.type === "upkeep"
            ? taskNames.get(event.subjectId)
            : null;
        if (name) {
          updated = true;
          return { ...event, subjectName: name };
        }
      }
      return event;
    });

    if (updated) {
      setEvents(updatedEvents);
    }
  }, [events.length, recipeNames, taskNames]);

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

  // Get URL for an event based on its type
  const getEventUrl = (event: TimelineEvent): string | null => {
    switch (event.type) {
      case "recipe":
        return `/recipes/boxes/${event.containerId}/recipes/${event.subjectId}`;
      case "upkeep": {
        const slug = upkeepSlugMap.get(event.containerId);
        return slug ? `/upkeep/${slug}` : null;
      }
      case "life":
        return `/life`;
      default:
        return null;
    }
  };

  const handleEventClick = (event: TimelineEvent) => {
    const url = getEventUrl(event);
    if (url) {
      navigate(url);
    }
  };

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
              const url = getEventUrl(event);
              const isClickable = url !== null;

              return (
                <EventCard
                  key={`${event.type}-${event.id}`}
                  $clickable={isClickable}
                  onClick={isClickable ? () => handleEventClick(event) : undefined}
                >
                  <EventIcon $color={config.color}>{config.icon}</EventIcon>
                  <EventContent>
                    <EventHeader>
                      <Tag color={config.color}>{config.label}</Tag>
                      <EventTitle>{name}</EventTitle>
                      <EventTime>{formatTime(event.timestamp)}</EventTime>
                    </EventHeader>
                    {notes && <EventNote>"{notes}"</EventNote>}
                  </EventContent>
                  {isClickable && (
                    <EventArrow>
                      <RightOutlined />
                    </EventArrow>
                  )}
                </EventCard>
              );
            })}
          </div>
        ))}
      </TimelineList>
    </Container>
  );
}
