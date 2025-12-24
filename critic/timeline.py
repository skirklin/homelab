"""
Timeline reconstruction - orders events and detects temporal inconsistencies.
"""

from .schema import (
    ChunkWithText,
    TimelineView,
    TimelineEvent,
    TimelineInconsistency,
    TimeSpan,
)


def reconstruct_timeline(chunks: list[ChunkWithText]) -> TimelineView:
    """
    Reconstruct the narrative timeline from extracted events.

    This is a simplified implementation that:
    1. Orders events by chunk appearance
    2. Detects obvious inconsistencies based on time markers

    Args:
        chunks: Chunks with extracted events

    Returns:
        TimelineView with events, inconsistencies, and spans
    """
    events: list[TimelineEvent] = []
    position = 0.0

    for chunk in chunks:
        for event in chunk.extraction.events:
            events.append(TimelineEvent(
                event_id=event.id,
                position=position,
                confidence=_get_confidence(event.precision),
            ))
            position += 1.0

    # Detect inconsistencies (simplified)
    inconsistencies = _detect_inconsistencies(chunks)

    # Build time spans (simplified - one per chunk)
    spans = [
        TimeSpan(
            id=f"span-{i}",
            name=chunk.title or f"Section {i + 1}",
            start_position=float(i),
            end_position=float(i + 1),
        )
        for i, chunk in enumerate(chunks)
    ]

    return TimelineView(
        events=events,
        inconsistencies=inconsistencies,
        spans=spans,
    )


def _get_confidence(precision: str) -> float:
    """Get confidence score based on precision."""
    scores = {
        'exact': 0.9,
        'relative': 0.6,
        'vague': 0.3,
    }
    return scores.get(precision, 0.5)


def _detect_inconsistencies(chunks: list[ChunkWithText]) -> list[TimelineInconsistency]:
    """Detect temporal inconsistencies (simplified)."""
    inconsistencies: list[TimelineInconsistency] = []

    # Look for conflicting time markers
    # This is a simplified check - a full implementation would parse dates/times

    time_refs: dict[str, list[str]] = {}  # time_marker -> [event_ids]

    for chunk in chunks:
        for event in chunk.extraction.events:
            marker = event.time_marker.lower().strip()
            if marker and marker not in ('continuing', 'scene break'):
                if marker not in time_refs:
                    time_refs[marker] = []
                time_refs[marker].append(event.id)

    # Look for contradictory time references
    # (e.g., "Monday" and "three days later" when that doesn't make sense)
    # This would require more sophisticated parsing in a real implementation

    return inconsistencies
