/** Life tracker domain types */

export interface LifeLog {
  id: string;
  sampleSchedule: unknown;
  /** "HH:MM" 24h string, or null/undefined when no morning reminder is set. */
  morningReminderTime?: string | null;
  /** "HH:MM" 24h string, or null/undefined when no evening reminder is set. */
  eveningReminderTime?: string | null;
  created: string;
  updated: string;
}

export interface LifeEntry {
  id: string;
  log: string;
  widgetId: string;
  timestamp: Date;
  createdBy: string;
  data: Record<string, unknown>;
  notes?: string;
  created: string;
  updated: string;
}
