"""
Timeline reconstruction - uses the model to build entity-centric chronological timelines.

The model analyzes all extracted events to:
1. Identify the story's temporal anchor point (Day 0)
2. Normalize all times relative to that anchor
3. Build per-character and per-location timelines
4. Sort events chronologically within each entity's perspective
"""

import json
from typing import Optional

import anthropic

from critic.retry import retry_api_call
from critic.schema import (
    ChunkWithText,
    CharacterEntity,
    TimelineView,
    TimelineEvent,
    TimeAnchor,
    EntityTimeline,
)
from critic.config import DEFAULT_MODEL


def reconstruct_timeline(
    chunks: list[ChunkWithText],
    characters: Optional[list[CharacterEntity]] = None,
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
) -> TimelineView:
    """
    Reconstruct entity-centric chronological timelines from extracted events.

    The model analyzes all events to understand:
    - The story's temporal structure (present day, flashbacks, etc.)
    - When each event actually occurred relative to the anchor point
    - Which characters and locations are involved in each event
    - The chronological sequence for each entity

    Args:
        chunks: Chunks with extracted events
        api_key: Anthropic API key
        model: Model to use for timeline analysis

    Returns:
        TimelineView with entity-centric timelines
    """
    # Collect all events with their narrative context
    all_events = []
    chapters = []
    characters_seen = set()
    locations_seen = set()

    for chunk in chunks:
        chapter_name = chunk.title or f"Section {len(chapters) + 1}"
        chapters.append(chapter_name)

        for event in chunk.extraction.events:
            all_events.append({
                "id": event.id,
                "description": event.description,
                "time_marker": event.time_marker,
                "chapter": chapter_name,
                "chunk_id": chunk.id,
                "character_ids": event.character_ids,
                "narrative_order": len(all_events),
            })
            characters_seen.update(event.character_ids)

        # Collect locations from scenes
        for scene in chunk.extraction.scenes:
            if scene.location:
                locations_seen.add(scene.location)

    if not all_events:
        return TimelineView(chapters=chapters)

    # Build character ID mapping from entities
    char_id_map = {}
    if characters:
        for char in characters:
            char_id_map[char.name.lower()] = char.id
            for alias in char.aliases:
                char_id_map[alias.lower()] = char.id

    # Use model to build chronological timeline
    client = anthropic.Anthropic(api_key=api_key)

    prompt = _build_timeline_prompt(
        all_events,
        characters or [],
        list(locations_seen),
    )

    response_text = ""

    def make_request():
        nonlocal response_text
        response_text = ""

        with client.messages.stream(
            model=model,
            max_tokens=16000,
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            for text in stream.text_stream:
                response_text += text

    def on_retry(attempt, delay, _exc):
        print(f"  Rate limited during timeline reconstruction, waiting {delay:.0f}s (attempt {attempt})...")

    retry_api_call(make_request, on_retry=on_retry)

    # Parse the model's response
    timeline_data = _parse_timeline_response(response_text, all_events)

    return _build_timeline_view(timeline_data, all_events, chapters)


def _build_timeline_prompt(
    events: list[dict],
    characters: list[CharacterEntity],
    locations: list[str],
) -> str:
    """Build the prompt for entity-centric timeline analysis."""

    events_text = "\n".join([
        f"- [{e['id']}] Characters: {e['character_ids']} | Time: \"{e['time_marker']}\" | {e['description']}"
        for e in events
    ])

    # Format characters with their IDs so model uses correct IDs
    if characters:
        characters_text = "\n".join([
            f"- {char.id}: {char.name}" + (f" (aliases: {', '.join(char.aliases)})" if char.aliases else "")
            for char in characters
        ])
    else:
        characters_text = "(extract from events)"
    locations_text = ", ".join(locations) if locations else "(extract from event descriptions)"

    return f"""Analyze these events from a novel and build ENTITY-CENTRIC chronological timelines.

Events are listed in NARRATIVE order (as they appear in the story), but many are flashbacks or references to past events. Your job is to:
1. Figure out WHEN each event actually happened
2. Build a separate timeline for each major character showing their journey
3. Optionally build location-based timelines for key settings

## Events (in narrative order):
{events_text}

## Known Characters (use these exact IDs):
{characters_text}

## Known Locations:
{locations_text}

## Your Task:

1. **Identify the temporal anchor**: What is the story's "present day"? This becomes Day 0.
   Example: "Detective arrives on the island Tuesday morning" = Day 0

2. **Normalize all times** relative to Day 0:
   - "Day 0, 6:00 AM" = specific time on present day
   - "Day -1, 11:00 PM" = yesterday late night
   - "Day -3" = three days before
   - "Years ago: -25" = distant past (25 years before)

3. **Build character timelines**: For each major character, list their events in chronological order.

4. **Identify locations** for events where possible.

Return as JSON:
{{
  "anchor_point": "Tuesday morning - Detective Sarah Chen arrives on Wraith Island",
  "time_anchors": [
    {{"id": "day-minus-25-years", "name": "25 Years Ago", "day_offset": -9125, "description": "Historical events"}},
    {{"id": "day-minus-3", "name": "Day -3 (Saturday)", "day_offset": -3, "description": "Emma's body discovered"}},
    {{"id": "day-minus-1", "name": "Day -1 (Monday)", "day_offset": -1, "description": "The night of the murder"}},
    {{"id": "day-0", "name": "Day 0 (Tuesday)", "day_offset": 0, "description": "Investigation begins"}}
  ],
  "global_events": [
    {{
      "id": "chunk-9-event-1",
      "normalized_time": "Years ago: -25",
      "location": "Wraith Island",
      "is_flashback": true
    }},
    {{
      "id": "chunk-1-event-0",
      "normalized_time": "Day 0, 6:00 AM",
      "location": "Ferry dock",
      "is_flashback": false
    }}
    // ... ALL events in CHRONOLOGICAL order (earliest first)
  ],
  "character_timelines": [
    {{
      "character_id": "char-1",  // Use the EXACT character_id from the Known Characters list above
      "character_name": "Sarah Chen",
      "event_ids": ["chunk-1-event-0", "chunk-1-event-1", ...]  // Her events in chronological order
    }},
    {{
      "character_id": "char-2",  // Use the EXACT character_id from the Known Characters list above
      "character_name": "Emma Hartley",
      "event_ids": ["chunk-3-event-5", "chunk-4-event-2", ...]  // Her events chronologically
    }}
  ],
  "location_timelines": [
    {{
      "location_id": "loc-lighthouse",
      "location_name": "The Lighthouse",
      "event_ids": ["chunk-2-event-0", ...]  // Events at this location chronologically
    }}
  ]
}}

IMPORTANT:
- global_events must be sorted CHRONOLOGICALLY (earliest first, including flashbacks at their actual time)
- Include ALL events from the input
- Character timelines should only include events where that character is directly involved
- For "continuing" time markers, place them right after the previous event in that scene
- is_flashback=true when an event is TOLD as a memory/flashback but happened in the past
- CRITICAL: Use the EXACT character_id values from the Known Characters list (e.g., "char-1", "char-14"). Do NOT invent new IDs."""


def _parse_timeline_response(response: str, original_events: list[dict]) -> dict:
    """Parse the model's timeline response."""

    # Extract JSON from response
    json_match = None
    if "```json" in response:
        start = response.find("```json") + 7
        end = response.find("```", start)
        json_match = response[start:end].strip()
    elif "```" in response:
        start = response.find("```") + 3
        end = response.find("```", start)
        json_match = response[start:end].strip()
    elif "{" in response:
        start = response.find("{")
        end = response.rfind("}") + 1
        json_match = response[start:end]

    if json_match:
        try:
            data = json.loads(json_match)

            # Validate we have all events
            returned_ids = {e["id"] for e in data.get("global_events", [])}
            original_ids = {e["id"] for e in original_events}

            # Add any missing events at the end
            missing = original_ids - returned_ids
            if missing:
                for orig in original_events:
                    if orig["id"] in missing:
                        data["global_events"].append({
                            "id": orig["id"],
                            "normalized_time": orig["time_marker"],
                            "location": None,
                            "is_flashback": False,
                        })

            return data
        except json.JSONDecodeError:
            pass

    # Fallback: return events in original order
    return {
        "anchor_point": "Unknown",
        "time_anchors": [],
        "global_events": [
            {"id": e["id"], "normalized_time": e["time_marker"], "location": None, "is_flashback": False}
            for e in original_events
        ],
        "character_timelines": [],
        "location_timelines": [],
    }


def _build_timeline_view(
    timeline_data: dict,
    original_events: list[dict],
    chapters: list[str],
) -> TimelineView:
    """Build the TimelineView from parsed model response."""

    # Create lookup for original events
    event_lookup = {e["id"]: e for e in original_events}

    # Build global events list
    global_events = []
    for i, evt in enumerate(timeline_data.get("global_events", [])):
        orig = event_lookup.get(evt["id"])
        if orig:
            global_events.append(TimelineEvent(
                event_id=evt["id"],
                description=orig["description"],
                normalized_time=evt.get("normalized_time", orig["time_marker"]),
                original_time_marker=orig["time_marker"],
                chapter=orig["chapter"],
                sequence=i,
                is_flashback=evt.get("is_flashback", False),
                character_ids=orig["character_ids"],
                location=evt.get("location"),
                chunk_id=orig["chunk_id"],
            ))

    # Build time anchors
    time_anchors = []
    for anchor in timeline_data.get("time_anchors", []):
        time_anchors.append(TimeAnchor(
            id=anchor.get("id", f"anchor-{len(time_anchors)}"),
            name=anchor.get("name", "Unknown"),
            day_offset=anchor.get("day_offset", 0),
            description=anchor.get("description"),
        ))

    # Build character timelines
    entity_timelines = []

    for char_timeline in timeline_data.get("character_timelines", []):
        char_events = []
        for i, event_id in enumerate(char_timeline.get("event_ids", [])):
            # Find the global event
            global_evt = next((e for e in global_events if e.event_id == event_id), None)
            if global_evt:
                # Create a copy with sequence for this character's timeline
                char_events.append(TimelineEvent(
                    event_id=global_evt.event_id,
                    description=global_evt.description,
                    normalized_time=global_evt.normalized_time,
                    original_time_marker=global_evt.original_time_marker,
                    chapter=global_evt.chapter,
                    sequence=i,
                    is_flashback=global_evt.is_flashback,
                    character_ids=global_evt.character_ids,
                    location=global_evt.location,
                    chunk_id=global_evt.chunk_id,
                ))

        if char_events:
            entity_timelines.append(EntityTimeline(
                entity_id=char_timeline.get("character_id", f"char-{len(entity_timelines)}"),
                entity_name=char_timeline.get("character_name", "Unknown"),
                entity_type="character",
                events=char_events,
            ))

    # Build location timelines
    for loc_timeline in timeline_data.get("location_timelines", []):
        loc_events = []
        for i, event_id in enumerate(loc_timeline.get("event_ids", [])):
            global_evt = next((e for e in global_events if e.event_id == event_id), None)
            if global_evt:
                loc_events.append(TimelineEvent(
                    event_id=global_evt.event_id,
                    description=global_evt.description,
                    normalized_time=global_evt.normalized_time,
                    original_time_marker=global_evt.original_time_marker,
                    chapter=global_evt.chapter,
                    sequence=i,
                    is_flashback=global_evt.is_flashback,
                    character_ids=global_evt.character_ids,
                    location=global_evt.location,
                    chunk_id=global_evt.chunk_id,
                ))

        if loc_events:
            entity_timelines.append(EntityTimeline(
                entity_id=loc_timeline.get("location_id", f"loc-{len(entity_timelines)}"),
                entity_name=loc_timeline.get("location_name", "Unknown"),
                entity_type="location",
                events=loc_events,
            ))

    return TimelineView(
        anchor_point=timeline_data.get("anchor_point", ""),
        global_events=global_events,
        entity_timelines=entity_timelines,
        time_anchors=time_anchors,
        chapters=chapters,
    )


def reconstruct_timeline_simple(chunks: list[ChunkWithText]) -> TimelineView:
    """
    Simple timeline reconstruction without model calls.

    Use this when you want to skip the API call and just get narrative order.
    Events are ordered by appearance in the text, not chronologically.
    """
    events: list[TimelineEvent] = []
    chapters = []

    for chunk in chunks:
        chapter_name = chunk.title or f"Section {len(chapters) + 1}"
        chapters.append(chapter_name)

        for event in chunk.extraction.events:
            events.append(TimelineEvent(
                event_id=event.id,
                description=event.description,
                normalized_time=event.time_marker,
                original_time_marker=event.time_marker,
                chapter=chapter_name,
                sequence=len(events),
                character_ids=event.character_ids,
                chunk_id=chunk.id,
            ))

    return TimelineView(
        global_events=events,
        chapters=chapters,
    )
