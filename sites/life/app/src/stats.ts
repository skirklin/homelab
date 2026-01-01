import type { LogEntry, ActivityDef } from "./types";

export interface ActivityStats {
  activityId: string;
  totalEntries: number;
  totalMinutes: number;
  averageDuration: number; // minutes
  lastEntry: Date | null;
}

export interface DailyStats {
  date: string; // YYYY-MM-DD
  entriesByActivity: Map<string, number>;
  minutesByActivity: Map<string, number>;
}

export function calculateActivityStats(
  entries: LogEntry[],
  activities: ActivityDef[]
): ActivityStats[] {
  const stats = new Map<string, ActivityStats>();

  // Initialize stats for all activities
  for (const activity of activities) {
    stats.set(activity.id, {
      activityId: activity.id,
      totalEntries: 0,
      totalMinutes: 0,
      averageDuration: 0,
      lastEntry: null,
    });
  }

  // Calculate stats from entries
  for (const entry of entries) {
    const stat = stats.get(entry.activityId);
    if (!stat) continue;

    stat.totalEntries++;
    if (entry.duration !== null) {
      stat.totalMinutes += entry.duration;
    }
    if (!stat.lastEntry || entry.startTime > stat.lastEntry) {
      stat.lastEntry = entry.startTime;
    }
  }

  // Calculate averages
  for (const stat of stats.values()) {
    if (stat.totalEntries > 0) {
      stat.averageDuration = Math.round(stat.totalMinutes / stat.totalEntries);
    }
  }

  return Array.from(stats.values());
}

export function calculateWeeklyStats(entries: LogEntry[]): DailyStats[] {
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const dailyStats = new Map<string, DailyStats>();

  // Initialize last 7 days
  for (let i = 0; i < 7; i++) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    dailyStats.set(dateStr, {
      date: dateStr,
      entriesByActivity: new Map(),
      minutesByActivity: new Map(),
    });
  }

  // Aggregate entries
  for (const entry of entries) {
    const dateStr = entry.startTime.toISOString().split("T")[0];
    const stat = dailyStats.get(dateStr);
    if (!stat) continue;

    const entryCount = stat.entriesByActivity.get(entry.activityId) ?? 0;
    stat.entriesByActivity.set(entry.activityId, entryCount + 1);

    if (entry.duration !== null) {
      const minutes = stat.minutesByActivity.get(entry.activityId) ?? 0;
      stat.minutesByActivity.set(entry.activityId, minutes + entry.duration);
    }
  }

  return Array.from(dailyStats.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// Export functions
export interface ExportEntry {
  activity: string;
  startTime: string;
  endTime: string | null;
  duration: number | null;
  notes: string;
}

export function exportEntriesToCSV(entries: LogEntry[], activities: ActivityDef[]): string {
  const activityMap = new Map(activities.map(a => [a.id, a.label]));

  const headers = ["Activity", "Start Time", "End Time", "Duration (min)", "Notes"];
  const rows = entries.map(entry => [
    activityMap.get(entry.activityId) ?? "Unknown",
    entry.startTime.toISOString(),
    entry.endTime?.toISOString() ?? "",
    entry.duration?.toString() ?? "",
    `"${entry.notes.replace(/"/g, '""')}"`,
  ]);

  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

export function exportEntriesToJSON(entries: LogEntry[], activities: ActivityDef[]): string {
  const activityMap = new Map(activities.map(a => [a.id, a.label]));

  const exportData: ExportEntry[] = entries.map(entry => ({
    activity: activityMap.get(entry.activityId) ?? "Unknown",
    startTime: entry.startTime.toISOString(),
    endTime: entry.endTime?.toISOString() ?? null,
    duration: entry.duration,
    notes: entry.notes,
  }));

  return JSON.stringify(exportData, null, 2);
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
