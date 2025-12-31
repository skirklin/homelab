import { useState } from "react";
import styled from "styled-components";
import { Button } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { useAuth } from "@kirkl/shared";
import { useLife } from "../context";
import { useEntriesSubscription } from "../subscription";
import { ActivityCard } from "./ActivityCard";
import { LogEntryModal } from "./LogEntryModal";
import { RecentEntries } from "./RecentEntries";
import type { ActivityType, LogEntry } from "../../../shared/types";

const Container = styled.div`
  padding: var(--space-lg);
  max-width: 800px;
  margin: 0 auto;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-lg);
`;

const Title = styled.h1`
  margin: 0;
  color: var(--color-text);
`;


const ActivityGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-md);
  margin-bottom: var(--space-xl);

  @media (min-width: 600px) {
    grid-template-columns: repeat(4, 1fr);
  }
`;

const Section = styled.section`
  margin-bottom: var(--space-xl);
`;

const SectionHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-md);
`;

const SectionTitle = styled.h2`
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--color-text);
`;

const activityTypes: ActivityType[] = ["sleep", "gym", "stretch", "work"];

export function LifeDashboard() {
  const { user } = useAuth();
  const { state } = useLife();
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LogEntry | null>(null);
  const [selectedType, setSelectedType] = useState<ActivityType | null>(null);

  // Subscribe to entries
  useEntriesSubscription(state.log?.id ?? null);

  const handleEditEntry = (entry: LogEntry) => {
    setEditingEntry(entry);
    setSelectedType(entry.type);
    setShowAddEntry(true);
  };

  const handleCloseModal = () => {
    setShowAddEntry(false);
    setEditingEntry(null);
    setSelectedType(null);
  };

  // Find active entries (started but not stopped)
  const activeEntries = Array.from(state.entries.values()).filter(
    (e) => e.endTime === null
  );

  // Get recent entries
  const recentEntries = Array.from(state.entries.values())
    .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
    .slice(0, 10);

  return (
    <Container>
      <Header>
        <Title>Life Tracker</Title>
      </Header>

      <Section>
        <SectionTitle>Activities</SectionTitle>
        <ActivityGrid>
          {activityTypes.map((type) => (
            <ActivityCard
              key={type}
              type={type}
              activeEntry={activeEntries.find((e) => e.type === type)}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
            />
          ))}
        </ActivityGrid>
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>Recent Entries</SectionTitle>
          <Button
            icon={<PlusOutlined />}
            onClick={() => setShowAddEntry(true)}
          >
            Add Entry
          </Button>
        </SectionHeader>
        <RecentEntries entries={recentEntries} onEdit={handleEditEntry} />
      </Section>

      <LogEntryModal
        open={showAddEntry}
        onClose={handleCloseModal}
        entry={editingEntry}
        defaultType={selectedType}
        logId={state.log?.id}
        userId={user?.uid ?? ""}
      />
    </Container>
  );
}
