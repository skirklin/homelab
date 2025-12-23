/**
 * Timeline Reconstruction
 *
 * Takes events from chunks and attempts to:
 * 1. Order them chronologically
 * 2. Detect temporal relationships
 * 3. Find timeline inconsistencies
 */
/**
 * Reconstruct timeline from events across chunks
 */
export function reconstructTimeline(chunks) {
    // Collect all events
    const allEvents = [];
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
    const timelineEvents = sortedEvents.map((event, idx) => ({
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
/**
 * Parse a time marker string into structured time info
 */
function parseTimeMarker(marker) {
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
    let timeOfDay;
    if (/\b(morning|dawn|sunrise|breakfast)\b/.test(lowerMarker)) {
        timeOfDay = 'morning';
    }
    else if (/\b(afternoon|noon|midday|lunch)\b/.test(lowerMarker)) {
        timeOfDay = 'afternoon';
    }
    else if (/\b(evening|dusk|sunset|dinner)\b/.test(lowerMarker)) {
        timeOfDay = 'evening';
    }
    else if (/\b(night|midnight|late)\b/.test(lowerMarker)) {
        timeOfDay = 'night';
    }
    // Check for relative time markers
    const relativePatterns = [
        { pattern: /(\d+)\s+days?\s+(later|after)/i, type: 'days_later' },
        { pattern: /(\d+)\s+days?\s+(before|earlier)/i, type: 'days_before' },
        { pattern: /(\d+)\s+weeks?\s+(later|after)/i, type: 'weeks_later' },
        { pattern: /(the\s+)?next\s+(day|morning|evening)/i, type: 'next_day' },
        { pattern: /(the\s+)?previous\s+(day|night)/i, type: 'previous_day' },
        { pattern: /that\s+(same\s+)?(day|morning|evening|night)/i, type: 'same_day' },
        { pattern: /later\s+that\s+(day|night)/i, type: 'same_day_later' },
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
    // Unknown
    return {
        type: 'unknown',
        confidence: 0.1,
        sortOrdinal: 0,
    };
}
/**
 * Sort events by time, using chunk order as fallback
 */
function sortEvents(events) {
    // First, assign sort ordinals based on chunk order and relative times
    let currentOrdinal = 0;
    // Group by chunk
    const byChunk = new Map();
    for (const event of events) {
        if (!byChunk.has(event.chunkIndex)) {
            byChunk.set(event.chunkIndex, []);
        }
        byChunk.get(event.chunkIndex).push(event);
    }
    // Process chunks in order
    const chunkIndices = Array.from(byChunk.keys()).sort((a, b) => a - b);
    for (const chunkIndex of chunkIndices) {
        const chunkEvents = byChunk.get(chunkIndex);
        // Sort within chunk by time of day if available
        chunkEvents.sort((a, b) => {
            const timeOrder = { morning: 0, afternoon: 1, evening: 2, night: 3 };
            const aOrder = a.parsedTime.timeOfDay ? timeOrder[a.parsedTime.timeOfDay] : 1.5;
            const bOrder = b.parsedTime.timeOfDay ? timeOrder[b.parsedTime.timeOfDay] : 1.5;
            return aOrder - bOrder;
        });
        // Assign ordinals
        for (const event of chunkEvents) {
            event.parsedTime.sortOrdinal = currentOrdinal++;
        }
    }
    // Final sort by ordinal
    return events.sort((a, b) => a.parsedTime.sortOrdinal - b.parsedTime.sortOrdinal);
}
/**
 * Detect timeline inconsistencies
 */
function detectTimelineInconsistencies(events, chunks) {
    const inconsistencies = [];
    // Check for day-of-week conflicts
    const dayMentions = new Map();
    for (const event of events) {
        if (event.parsedTime.dayOfWeek) {
            const day = event.parsedTime.dayOfWeek;
            if (!dayMentions.has(day)) {
                dayMentions.set(day, []);
            }
            dayMentions.get(day).push(event);
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
        if (current.parsedTime.relativeOffset?.includes('later') &&
            next.parsedTime.relativeOffset?.includes('before')) {
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
function detectTimeSpans(events) {
    const spans = [];
    let spanIdCounter = 0;
    // Look for named periods in event descriptions
    const periodPatterns = [
        /during\s+the\s+(\w+)/i,
        /the\s+(\w+)\s+(?:period|days?|weeks?|time)/i,
        /(?:the\s+)?(\w+\s+storm)/i,
    ];
    const foundPeriods = new Map();
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
                foundPeriods.get(periodName).events.push(event);
                foundPeriods.get(periodName).positions.push(position);
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
//# sourceMappingURL=timeline.js.map