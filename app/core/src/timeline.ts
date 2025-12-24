/**
 * Timeline Reconstruction
 *
 * Takes events from chunks and attempts to:
 * 1. Order them chronologically
 * 2. Detect temporal relationships
 * 3. Find timeline inconsistencies
 */

import type {
  ChunkWithText,
  TimelineView,
  TimelineEvent,
  TimelineInconsistency,
  TimeSpan,
  EventExtraction,
} from './output-schema.js';

/**
 * Reconstruct timeline from events across chunks
 */
export function reconstructTimeline(chunks: ChunkWithText[]): TimelineView {
  // Collect all events
  const allEvents: Array<EventExtraction & { chunkIndex: number }> = [];

  chunks.forEach((chunk, chunkIndex) => {
    for (const event of chunk.extraction.events) {
      allEvents.push({ ...event, chunkIndex });
    }
  });

  // Parse time markers and assign relative positions
  const parsedEvents = allEvents.map((event) => ({
    ...event,
    parsedTime: parseTimeMarker(event.timeMarker),
  }));

  // Sort events by parsed time and chunk order
  const sortedEvents = sortEvents(parsedEvents);

  // Assign positions (0-1 scale)
  const timelineEvents: TimelineEvent[] = sortedEvents.map((event, idx) => ({
    eventId: event.id,
    position: sortedEvents.length > 1 ? idx / (sortedEvents.length - 1) : 0.5,
    confidence: event.parsedTime.confidence,
  }));

  // Detect inconsistencies
  const inconsistencies = detectTimelineInconsistencies(parsedEvents, chunks);

  // Detect time spans (e.g., "the storm", "three days")
  const spans = detectTimeSpans(parsedEvents);

  return {
    events: timelineEvents,
    inconsistencies,
    spans,
  };
}

interface ParsedTime {
  /** Type of time marker */
  type: 'absolute' | 'relative' | 'vague' | 'unknown';
  /** Confidence in parsing (0-1) */
  confidence: number;
  /** For absolute times: parsed date */
  absoluteDate?: Date;
  /** For relative times: what it's relative to */
  relativeAnchor?: string;
  /** For relative times: offset description */
  relativeOffset?: string;
  /** Day of week if mentioned */
  dayOfWeek?: string;
  /** Time of day if mentioned */
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
  /** Ordinal for sorting (higher = later) */
  sortOrdinal: number;
}

/**
 * Parse a time marker string into structured time info
 */
function parseTimeMarker(marker: string): ParsedTime {
  const lowerMarker = marker.toLowerCase();

  // Check for absolute dates
  const datePatterns = [
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/,
    /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i,
    /(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)/i,
  ];

  for (const pattern of datePatterns) {
    if (pattern.test(marker)) {
      return {
        type: 'absolute',
        confidence: 0.9,
        sortOrdinal: 0, // Will be set during sorting
      };
    }
  }

  // Check for days of week
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const dayMatch = days.find((day) => lowerMarker.includes(day));

  // Check for time of day
  let timeOfDay: ParsedTime['timeOfDay'];
  if (/\b(morning|dawn|sunrise|breakfast)\b/.test(lowerMarker)) {
    timeOfDay = 'morning';
  } else if (/\b(afternoon|noon|midday|lunch)\b/.test(lowerMarker)) {
    timeOfDay = 'afternoon';
  } else if (/\b(evening|dusk|sunset|dinner)\b/.test(lowerMarker)) {
    timeOfDay = 'evening';
  } else if (/\b(night|midnight|late)\b/.test(lowerMarker)) {
    timeOfDay = 'night';
  }

  // Check for relative time markers
  const relativePatterns = [
    { pattern: /(\d+)\s+days?\s+(later|after)/i, type: 'days_later' as const },
    { pattern: /(\d+)\s+days?\s+(before|earlier)/i, type: 'days_before' as const },
    { pattern: /(\d+)\s+weeks?\s+(later|after)/i, type: 'weeks_later' as const },
    { pattern: /(the\s+)?next\s+(day|morning|evening)/i, type: 'next_day' as const },
    { pattern: /(the\s+)?previous\s+(day|night)/i, type: 'previous_day' as const },
    { pattern: /that\s+(same\s+)?(day|morning|evening|night)/i, type: 'same_day' as const },
    { pattern: /later\s+that\s+(day|night)/i, type: 'same_day_later' as const },
  ];

  for (const { pattern, type } of relativePatterns) {
    const match = lowerMarker.match(pattern);
    if (match) {
      return {
        type: 'relative',
        confidence: 0.7,
        relativeOffset: type,
        dayOfWeek: dayMatch,
        timeOfDay,
        sortOrdinal: 0,
      };
    }
  }

  // Vague time markers
  if (dayMatch || timeOfDay) {
    return {
      type: 'vague',
      confidence: 0.5,
      dayOfWeek: dayMatch,
      timeOfDay,
      sortOrdinal: 0,
    };
  }

  // Scene continuity markers
  if (/\b(continuing|same\s+scene|meanwhile)\b/i.test(lowerMarker)) {
    return {
      type: 'vague',
      confidence: 0.6, // Higher confidence - explicit continuity
      sortOrdinal: 0,
    };
  }

  // Scene break markers
  if (/\b(scene\s+break|later|afterward|subsequently)\b/i.test(lowerMarker)) {
    return {
      type: 'relative',
      confidence: 0.5,
      relativeOffset: 'later',
      sortOrdinal: 0,
    };
  }

  // Unknown
  return {
    type: 'unknown',
    confidence: 0.1,
    sortOrdinal: 0,
  };
}

interface ParsedEvent extends EventExtraction {
  chunkIndex: number;
  parsedTime: ParsedTime;
}

/**
 * Sort events chronologically using time markers, with narrative order as primary fallback
 *
 * Key insight: For narrative fiction, the order events appear in the text is usually
 * the intended chronological order, unless explicit time markers indicate otherwise.
 * We use time markers to detect jumps (flashbacks, time skips) but otherwise trust
 * narrative order.
 */
function sortEvents(events: ParsedEvent[]): ParsedEvent[] {
  if (events.length === 0) return events;

  // First pass: assign base day numbers by processing events in chunk order
  // and adjusting based on relative time markers
  let currentDay = 0;
  let eventWithinDay = 0; // For ordering events within the same day
  const timeOfDayOrder = { morning: 0.1, afternoon: 0.3, evening: 0.5, night: 0.7 };

  // Group by chunk for initial processing
  const byChunk = new Map<number, ParsedEvent[]>();
  for (const event of events) {
    if (!byChunk.has(event.chunkIndex)) {
      byChunk.set(event.chunkIndex, []);
    }
    byChunk.get(event.chunkIndex)!.push(event);
  }

  const chunkIndices = Array.from(byChunk.keys()).sort((a, b) => a - b);

  // Track the last assigned ordinal for context
  let lastTimeOfDay: string | undefined;

  for (const chunkIndex of chunkIndices) {
    const chunkEvents = byChunk.get(chunkIndex)!;

    for (let i = 0; i < chunkEvents.length; i++) {
      const event = chunkEvents[i];
      const marker = event.timeMarker.toLowerCase();
      const offset = event.parsedTime.relativeOffset;

      // Check for explicit day-changing markers
      if (offset === 'next_day' || /next\s+(day|morning)/.test(marker)) {
        currentDay += 1;
        eventWithinDay = 0;
      } else if (/(\d+)\s+days?\s+(later|after)/.test(marker)) {
        const match = marker.match(/(\d+)\s+days?\s+(later|after)/);
        if (match) {
          currentDay += parseInt(match[1], 10);
          eventWithinDay = 0;
        }
      } else if (/(\d+)\s+weeks?\s+(later|after)/.test(marker)) {
        const match = marker.match(/(\d+)\s+weeks?\s+(later|after)/);
        if (match) {
          currentDay += parseInt(match[1], 10) * 7;
          eventWithinDay = 0;
        }
      } else if (offset === 'previous_day' || /previous|before|earlier/.test(marker)) {
        currentDay -= 1;
        eventWithinDay = 0;
      } else if (/scene\s*break/i.test(marker)) {
        // Scene break with unclear time - advance slightly
        eventWithinDay += 0.1;
      } else if (event.parsedTime.timeOfDay) {
        // If we have a new morning and last was night, advance day
        if (event.parsedTime.timeOfDay === 'morning' && lastTimeOfDay === 'night') {
          currentDay += 1;
          eventWithinDay = 0;
        }
      }
      // "continuing" or unknown markers - stay in current scene/day

      // Calculate sort ordinal
      // Priority: day > time of day > narrative order within day
      let timeOfDayFraction: number;
      if (event.parsedTime.timeOfDay) {
        timeOfDayFraction = timeOfDayOrder[event.parsedTime.timeOfDay];
      } else {
        // No explicit time of day - use narrative order within the day
        // Add small increment to preserve narrative order
        timeOfDayFraction = 0.4 + (eventWithinDay * 0.001);
        eventWithinDay++;
      }

      event.parsedTime.sortOrdinal = currentDay + timeOfDayFraction;
      lastTimeOfDay = event.parsedTime.timeOfDay;
    }
  }

  // Sort primarily by ordinal, but for events with low time confidence,
  // heavily weight narrative (chunk) order
  return events.sort((a, b) => {
    // If both have high confidence time markers, use chronological order
    if (a.parsedTime.confidence > 0.5 && b.parsedTime.confidence > 0.5) {
      const ordinalDiff = a.parsedTime.sortOrdinal - b.parsedTime.sortOrdinal;
      if (Math.abs(ordinalDiff) > 0.001) {
        return ordinalDiff;
      }
    }

    // For low confidence events, prefer narrative order
    // Compare chunk indices first
    if (a.chunkIndex !== b.chunkIndex) {
      return a.chunkIndex - b.chunkIndex;
    }

    // Same chunk - use location offset within chunk
    return a.location.startOffset - b.location.startOffset;
  });
}

/**
 * Detect timeline inconsistencies
 */
function detectTimelineInconsistencies(
  events: ParsedEvent[],
  chunks: ChunkWithText[]
): TimelineInconsistency[] {
  const inconsistencies: TimelineInconsistency[] = [];

  // Check for day-of-week conflicts
  const dayMentions = new Map<string, ParsedEvent[]>();

  for (const event of events) {
    if (event.parsedTime.dayOfWeek) {
      const day = event.parsedTime.dayOfWeek;
      if (!dayMentions.has(day)) {
        dayMentions.set(day, []);
      }
      dayMentions.get(day)!.push(event);
    }
  }

  // Check for events on same day that seem too far apart in the narrative
  for (const [day, dayEvents] of dayMentions) {
    if (dayEvents.length >= 2) {
      const chunkSpread = Math.max(...dayEvents.map((e) => e.chunkIndex)) -
        Math.min(...dayEvents.map((e) => e.chunkIndex));

      if (chunkSpread > 3) {
        // Events on same day spread across many chapters - suspicious
        inconsistencies.push({
          description: `Events claimed to occur on "${day}" span multiple chapters (${chunkSpread} chapters apart)`,
          eventIds: dayEvents.map((e) => e.id),
          issueId: '', // Will be assigned later
        });
      }
    }
  }

  // Check for relative time conflicts
  // e.g., "three days later" followed by "the next morning" in wrong order
  for (let i = 0; i < events.length - 1; i++) {
    const current = events[i];
    const next = events[i + 1];

    if (
      current.parsedTime.relativeOffset?.includes('later') &&
      next.parsedTime.relativeOffset?.includes('before')
    ) {
      inconsistencies.push({
        description: `Time flow inconsistency: "${current.timeMarker}" followed by "${next.timeMarker}"`,
        eventIds: [current.id, next.id],
        issueId: '',
      });
    }
  }

  return inconsistencies;
}

/**
 * Detect time spans (periods of time in the narrative)
 */
function detectTimeSpans(events: ParsedEvent[]): TimeSpan[] {
  const spans: TimeSpan[] = [];
  let spanIdCounter = 0;

  // Look for named periods in event descriptions
  const periodPatterns = [
    /during\s+the\s+(\w+)/i,
    /the\s+(\w+)\s+(?:period|days?|weeks?|time)/i,
    /(?:the\s+)?(\w+\s+storm)/i,
  ];

  const foundPeriods = new Map<string, { events: ParsedEvent[]; positions: number[] }>();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const position = events.length > 1 ? i / (events.length - 1) : 0.5;

    for (const pattern of periodPatterns) {
      const match = event.description.match(pattern);
      if (match) {
        const periodName = match[1].toLowerCase();
        if (!foundPeriods.has(periodName)) {
          foundPeriods.set(periodName, { events: [], positions: [] });
        }
        foundPeriods.get(periodName)!.events.push(event);
        foundPeriods.get(periodName)!.positions.push(position);
      }
    }
  }

  for (const [name, { events: periodEvents, positions }] of foundPeriods) {
    if (periodEvents.length >= 1) {
      spans.push({
        id: `span-${++spanIdCounter}`,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        startPosition: Math.min(...positions),
        endPosition: Math.max(...positions),
        description: `Period spanning ${periodEvents.length} events`,
      });
    }
  }

  return spans;
}
