/** Observer domain types — AI-generated reflections over life_events windows. */

export interface ClaudeObservation {
  id: string;
  content: string;
  period: "weekly" | "monthly" | "adhoc";
  dataWindowStart: Date;
  dataWindowEnd: Date;
  relatedEventIds: string[];
  owner: string;
  promptVersion: string;
  created: Date;
}
