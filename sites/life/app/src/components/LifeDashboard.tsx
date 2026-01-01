import { useState } from "react";
import styled from "styled-components";
import { Button, Dropdown, message } from "antd";
import { PlusOutlined, SettingOutlined, DownloadOutlined } from "@ant-design/icons";
import { useAuth } from "@kirkl/shared";
import { useLife } from "../life-context";
import { useEntriesSubscription } from "../subscription";
import { ActivityCard } from "./ActivityCard";
import { LogEntryModal } from "./LogEntryModal";
import { RecentEntries } from "./RecentEntries";
import { ManageActivitiesModal } from "./ManageActivitiesModal";
import { exportEntriesToCSV, exportEntriesToJSON, downloadFile } from "../stats";
import type { LogEntry, ActivityDef } from "../types";

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

const HeaderButtons = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

const ActionButtons = styled.div`
  display: flex;
  gap: var(--space-sm);
`;

export function LifeDashboard() {
  const { user } = useAuth();
  const { state, dispatch } = useLife();
  const [showAddEntry, setShowAddEntry] = useState(false);
  const [editingEntry, setEditingEntry] = useState<LogEntry | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [showManageActivities, setShowManageActivities] = useState(false);

  // Subscribe to entries
  useEntriesSubscription(state.log?.id ?? null);

  const activities = state.log?.activities ?? [];
  const allEntries = Array.from(state.entries.values());

  const handleExport = (format: "csv" | "json") => {
    const sortedEntries = [...allEntries].sort(
      (a, b) => b.startTime.getTime() - a.startTime.getTime()
    );

    if (format === "csv") {
      const content = exportEntriesToCSV(sortedEntries, activities);
      const date = new Date().toISOString().split("T")[0];
      downloadFile(content, `life-tracker-export-${date}.csv`, "text/csv");
      message.success("Exported to CSV");
    } else {
      const content = exportEntriesToJSON(sortedEntries, activities);
      const date = new Date().toISOString().split("T")[0];
      downloadFile(content, `life-tracker-export-${date}.json`, "application/json");
      message.success("Exported to JSON");
    }
  };

  const exportMenuItems = [
    { key: "csv", label: "Export as CSV", onClick: () => handleExport("csv") },
    { key: "json", label: "Export as JSON", onClick: () => handleExport("json") },
  ];

  const handleEditEntry = (entry: LogEntry) => {
    setEditingEntry(entry);
    setSelectedActivityId(entry.activityId);
    setShowAddEntry(true);
  };

  const handleCloseModal = () => {
    setShowAddEntry(false);
    setEditingEntry(null);
    setSelectedActivityId(null);
  };

  const handleActivitiesUpdated = (updatedActivities: ActivityDef[]) => {
    if (state.log) {
      dispatch({
        type: "SET_LOG",
        log: { ...state.log, activities: updatedActivities },
      });
    }
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
        <SectionHeader>
          <SectionTitle>Activities</SectionTitle>
          <Button
            icon={<SettingOutlined />}
            onClick={() => setShowManageActivities(true)}
            size="small"
          >
            Manage
          </Button>
        </SectionHeader>
        <ActivityGrid>
          {activities.map((activity) => (
            <ActivityCard
              key={activity.id}
              activity={activity}
              activeEntry={activeEntries.find((e) => e.activityId === activity.id)}
              userId={user?.uid ?? ""}
              logId={state.log?.id}
            />
          ))}
        </ActivityGrid>
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>Recent Entries</SectionTitle>
          <ActionButtons>
            <Dropdown menu={{ items: exportMenuItems }} trigger={["click"]}>
              <Button icon={<DownloadOutlined />}>Export</Button>
            </Dropdown>
            <Button
              icon={<PlusOutlined />}
              onClick={() => setShowAddEntry(true)}
            >
              Add Entry
            </Button>
          </ActionButtons>
        </SectionHeader>
        <RecentEntries
          entries={recentEntries}
          activities={activities}
          onEdit={handleEditEntry}
        />
      </Section>

      <LogEntryModal
        open={showAddEntry}
        onClose={handleCloseModal}
        entry={editingEntry}
        defaultActivityId={selectedActivityId}
        activities={activities}
        logId={state.log?.id}
        userId={user?.uid ?? ""}
      />

      <ManageActivitiesModal
        open={showManageActivities}
        onClose={() => setShowManageActivities(false)}
        activities={activities}
        logId={state.log?.id}
        onActivitiesUpdated={handleActivitiesUpdated}
      />
    </Container>
  );
}
