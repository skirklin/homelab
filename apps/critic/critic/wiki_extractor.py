"""
Wiki extractor - extracts structured entity data from chapter summaries.

Creates Wikipedia-style entries for characters, locations, and a timeline
from the prose summaries generated during analysis.

Two-phase approach:
1. Parse structured sections from summaries to find ALL mentioned entities
2. Send pre-aggregated entity list to Claude for enrichment/consolidation
"""

import json
from dataclasses import dataclass, field
from typing import Optional

import anthropic
from anthropic.types import TextBlock

from critic.summarizer import ChapterSummary
from critic.summary_parser import (
    parse_summary,
    aggregate_characters,
)
from critic.config import DEFAULT_MODEL


@dataclass
class CharacterRelationship:
    """A relationship between two characters."""
    target: str
    relationship: str
    description: str = ""


@dataclass
class CharacterAppearance:
    """A character's appearance in a chapter."""
    chapter_id: str
    chapter_title: str
    role: str  # "major", "minor", "mentioned"
    summary: str = ""


@dataclass
class CharacterEntry:
    """A wiki entry for a character."""
    name: str
    aliases: list[str] = field(default_factory=list)
    description: str = ""
    physical: str = ""
    personality: str = ""
    background: str = ""
    relationships: list[CharacterRelationship] = field(default_factory=list)
    appearances: list[CharacterAppearance] = field(default_factory=list)
    arc: str = ""


@dataclass
class LocationEntry:
    """A wiki entry for a location."""
    name: str
    description: str = ""
    significance: str = ""
    scenes: list[str] = field(default_factory=list)
    associated_characters: list[str] = field(default_factory=list)


@dataclass
class TimelineEvent:
    """An event on the timeline."""
    description: str
    when: str
    where: Optional[str] = None
    characters: list[str] = field(default_factory=list)
    chapter_id: str = ""
    is_flashback: bool = False
    sequence: int = 0


@dataclass
class WikiData:
    """Complete wiki for a manuscript."""
    characters: list[CharacterEntry] = field(default_factory=list)
    locations: list[LocationEntry] = field(default_factory=list)
    timeline: list[TimelineEvent] = field(default_factory=list)


ENRICHMENT_PROMPT = """You are enriching wiki data extracted from a novel's chapter summaries.

I've already identified characters and their chapter appearances by parsing the summaries.
Your job is to consolidate this data and add missing details.

## Your Tasks:

1. **Consolidate Characters**: Merge duplicate entries (same person with different name forms).
   For each character, provide:
   - name: Their primary/canonical name
   - aliases: Other names they go by (include all variants found)
   - description: One paragraph overview of who they are
   - physical: Physical appearance (combine all mentions)
   - personality: Key personality traits
   - background: Backstory revealed in the text
   - relationships: List of objects with target, relationship, description fields
   - appearances: Keep the chapter appearances I provided
   - arc: Character development notes

2. **Extract Locations**: From the summaries, identify significant locations:
   - name: Location name
   - description: Physical description
   - significance: Why this place matters
   - scenes: Chapter IDs where scenes occur here
   - associated_characters: Characters connected to this location

3. **Build Timeline**: Extract major events in story-chronological order:
   - description: What happened
   - when: Time reference from text
   - where: Location
   - characters: Who was involved
   - chapter_id: Where revealed
   - is_flashback: True if told as backstory
   - sequence: Ordering number (0 = earliest in story time)

## Pre-Extracted Character Data:

{character_data}

## Chapter Summaries (for context and additional details):

{summaries}

Output JSON with structure:
{{
  "characters": [...],
  "locations": [...],
  "timeline": [...]
}}"""


def extract_wiki(
    summaries: list[ChapterSummary],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
) -> WikiData:
    """
    Extract wiki entries from chapter summaries.

    Uses two-phase approach:
    1. Parse summaries to find ALL mentioned characters
    2. Send to Claude for enrichment with pre-extracted entity list

    Args:
        summaries: Chapter summaries from the summarizer
        api_key: Anthropic API key
        model: Model to use

    Returns:
        WikiData with characters, locations, and timeline
    """
    # Phase 1: Parse structured sections from summaries
    print(f"[Wiki] Phase 1: Parsing {len(summaries)} chapter summaries...")

    parsed_summaries = [
        parse_summary(s.chapter_id, s.chapter_title, s.summary)
        for s in summaries
    ]

    # Aggregate character mentions across chapters
    char_aggregates = aggregate_characters(parsed_summaries)

    print(f"[Wiki] Found {len(char_aggregates)} unique character names across all chapters")

    # Build pre-extracted character data for the prompt
    character_data = _format_character_data(char_aggregates)

    # Combine all summaries for context
    all_summaries = "\n\n---\n\n".join(
        f"## {s.chapter_title} ({s.chapter_id})\n\n{s.summary}"
        for s in summaries
    )

    # Phase 2: Send to Claude for enrichment
    print("[Wiki] Phase 2: Enriching with Claude...")

    client = anthropic.Anthropic(api_key=api_key)

    prompt = ENRICHMENT_PROMPT.format(
        character_data=character_data,
        summaries=all_summaries,
    )

    response = client.messages.create(
        model=model,
        max_tokens=16384,
        system=[{
            "type": "text",
            "text": "You are a careful literary analyst creating wiki entries for a novel.",
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": prompt,
        }],
    )

    # Parse response
    text = ""
    if response.content and isinstance(response.content[0], TextBlock):
        text = response.content[0].text

    wiki = _parse_wiki_response(text)

    print(f"[Wiki] Generated: {len(wiki.characters)} characters, "
          f"{len(wiki.locations)} locations, {len(wiki.timeline)} events")

    return wiki


def _format_character_data(char_aggregates: dict) -> str:
    """Format pre-extracted character data for the enrichment prompt."""
    lines = []

    for name_key, appearances in sorted(char_aggregates.items()):
        # Get the most common name form
        name_counts: dict[str, int] = {}
        for app in appearances:
            name_counts[app.name] = name_counts.get(app.name, 0) + 1
        primary_name = max(name_counts.keys(), key=lambda n: name_counts[n])

        # Collect all name variants
        all_names = list(set(app.name for app in appearances))

        # Collect chapter appearances
        chapters = [f"{app.chapter_id} ({app.chapter_title})" for app in appearances]

        # Collect any physical/personality details found
        physical_bits = [app.physical for app in appearances if app.physical]
        personality_bits = [app.personality for app in appearances if app.personality]

        lines.append(f"### {primary_name}")
        if len(all_names) > 1:
            lines.append(f"Name variants: {', '.join(all_names)}")
        lines.append(f"Appears in: {', '.join(chapters)}")
        if physical_bits:
            lines.append(f"Physical notes: {'; '.join(physical_bits[:3])}")
        if personality_bits:
            lines.append(f"Personality notes: {'; '.join(personality_bits[:3])}")
        lines.append("")

    return "\n".join(lines)


def _parse_wiki_response(text: str) -> WikiData:
    """Parse the wiki JSON from model response."""
    import re

    # Try to find JSON in the response
    match = re.search(r'\{[\s\S]*\}', text)
    if not match:
        print("[Wiki] Warning: No JSON found in response")
        return WikiData()

    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError as e:
        print(f"[Wiki] Warning: JSON parse error: {e}")
        return WikiData()

    # Parse characters
    characters = []
    for c in data.get("characters", []):
        # Handle relationships - may be dicts or strings
        relationships = []
        for r in c.get("relationships", []):
            if isinstance(r, dict):
                relationships.append(CharacterRelationship(
                    target=r.get("target", ""),
                    relationship=r.get("relationship", ""),
                    description=r.get("description", ""),
                ))
            elif isinstance(r, str):
                relationships.append(CharacterRelationship(
                    target="",
                    relationship=r,
                    description="",
                ))

        # Handle appearances - may be dicts or strings
        appearances = []
        for a in c.get("appearances", []):
            if isinstance(a, dict):
                appearances.append(CharacterAppearance(
                    chapter_id=a.get("chapter_id", ""),
                    chapter_title=a.get("chapter_title", ""),
                    role=a.get("role", "minor"),
                    summary=a.get("summary", ""),
                ))
            elif isinstance(a, str):
                appearances.append(CharacterAppearance(
                    chapter_id=a,
                    chapter_title="",
                    role="mentioned",
                    summary="",
                ))

        characters.append(CharacterEntry(
            name=c.get("name", ""),
            aliases=c.get("aliases", []),
            description=c.get("description", ""),
            physical=c.get("physical", ""),
            personality=c.get("personality", ""),
            background=c.get("background", ""),
            relationships=relationships,
            appearances=appearances,
            arc=c.get("arc", ""),
        ))

    # Parse locations
    locations = []
    for loc in data.get("locations", []):
        locations.append(LocationEntry(
            name=loc.get("name", ""),
            description=loc.get("description", ""),
            significance=loc.get("significance", ""),
            scenes=loc.get("scenes", []),
            associated_characters=loc.get("associated_characters", []),
        ))

    # Parse timeline
    timeline = []
    for i, e in enumerate(data.get("timeline", [])):
        timeline.append(TimelineEvent(
            description=e.get("description", ""),
            when=e.get("when", ""),
            where=e.get("where"),
            characters=e.get("characters", []),
            chapter_id=e.get("chapter_id", ""),
            is_flashback=e.get("is_flashback", False),
            sequence=e.get("sequence", i),
        ))

    # Sort timeline by sequence
    timeline.sort(key=lambda e: e.sequence)

    return WikiData(characters=characters, locations=locations, timeline=timeline)
