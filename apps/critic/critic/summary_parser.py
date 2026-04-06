"""
Summary parser - extracts structured data from chapter summaries.

The summarizer outputs markdown with ## sections for Characters, Timeline, etc.
This module parses those sections to extract entity data programmatically,
ensuring we don't lose information when aggregating for the wiki.
"""

import re
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ParsedCharacter:
    """A character extracted from a chapter summary."""
    name: str
    chapter_id: str
    chapter_title: str
    role: str = ""  # major, minor, mentioned, etc.
    physical: str = ""
    personality: str = ""
    actions: str = ""
    relationships: list[str] = field(default_factory=list)
    raw_text: str = ""


@dataclass
class ParsedLocation:
    """A location extracted from a chapter summary."""
    name: str
    chapter_id: str
    description: str = ""


@dataclass
class ParsedEvent:
    """An event extracted from a chapter summary."""
    description: str
    chapter_id: str
    when: str = ""
    where: str = ""
    characters: list[str] = field(default_factory=list)


@dataclass
class ParsedSummary:
    """Parsed data from a chapter summary."""
    chapter_id: str
    chapter_title: str
    characters: list[ParsedCharacter] = field(default_factory=list)
    locations: list[ParsedLocation] = field(default_factory=list)
    events: list[ParsedEvent] = field(default_factory=list)


def parse_summary(chapter_id: str, chapter_title: str, summary_text: str) -> ParsedSummary:
    """
    Parse a structured chapter summary into components.

    Args:
        chapter_id: The chapter identifier
        chapter_title: The chapter title
        summary_text: The full summary text with ## sections

    Returns:
        ParsedSummary with extracted characters, locations, events
    """
    result = ParsedSummary(chapter_id=chapter_id, chapter_title=chapter_title)

    # Split into sections by ## headers
    sections = _split_sections(summary_text)

    # Parse characters section
    if "characters" in sections:
        result.characters = _parse_characters_section(
            sections["characters"], chapter_id, chapter_title
        )

    # Parse timeline/events section
    for key in ["timeline & events", "timeline", "events"]:
        if key in sections:
            result.events = _parse_events_section(sections[key], chapter_id)
            break

    # Parse key facts for locations
    if "key facts" in sections:
        result.locations = _parse_locations_from_facts(sections["key facts"], chapter_id)

    return result


def _split_sections(text: str) -> dict[str, str]:
    """Split summary into sections by ## headers."""
    sections = {}
    current_section = None
    current_content = []

    for line in text.split("\n"):
        if line.startswith("## "):
            if current_section:
                sections[current_section] = "\n".join(current_content).strip()
            current_section = line[3:].strip().lower()
            current_content = []
        elif line.startswith("# ") and not line.startswith("## "):
            # Skip top-level headers
            continue
        elif current_section:
            current_content.append(line)

    if current_section:
        sections[current_section] = "\n".join(current_content).strip()

    return sections


def _parse_characters_section(text: str, chapter_id: str, chapter_title: str) -> list[ParsedCharacter]:
    """Parse the ## Characters section into character entries."""
    characters = []

    # Look for character entries - typically start with **Name** or bold name
    # Split by double newlines or by bold markers at line start
    entries = re.split(r'\n(?=\*\*[A-Z])', text)

    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue

        char = _parse_character_entry(entry, chapter_id, chapter_title)
        if char:
            characters.append(char)

    return characters


def _parse_character_entry(entry: str, chapter_id: str, chapter_title: str) -> Optional[ParsedCharacter]:
    """Parse a single character entry."""
    # Extract name from **Name** or **Name** - description
    name_match = re.match(r'\*\*([^*]+)\*\*', entry)
    if not name_match:
        # Try other patterns
        name_match = re.match(r'([A-Z][a-z]+ [A-Z][a-z]+|[A-Z][a-z]+)', entry)

    if not name_match:
        return None

    name = name_match.group(1).strip()

    # Skip generic entries
    if name.lower() in ["the", "a", "an", "physical", "personality", "none"]:
        return None

    # Clean up name - remove parenthetical notes
    name = re.sub(r'\s*\([^)]+\)\s*$', '', name).strip()

    char = ParsedCharacter(
        name=name,
        chapter_id=chapter_id,
        chapter_title=chapter_title,
        raw_text=entry,
    )

    # Extract role if present
    role_match = re.search(r'(?:Role|Present|Status)[:\s]*([^\n]+)', entry, re.IGNORECASE)
    if role_match:
        char.role = role_match.group(1).strip()

    # Extract physical details
    physical_match = re.search(r'(?:Physical|Appearance)[:\s]*([^\n]+(?:\n(?![A-Z])[^\n]+)*)', entry, re.IGNORECASE)
    if physical_match:
        char.physical = physical_match.group(1).strip()

    # Extract personality
    personality_match = re.search(r'Personality[:\s]*([^\n]+(?:\n(?![A-Z])[^\n]+)*)', entry, re.IGNORECASE)
    if personality_match:
        char.personality = personality_match.group(1).strip()

    # Extract relationships
    rel_match = re.search(r'Relationship[s]?[:\s]*([^\n]+(?:\n(?!-)[^\n]+)*)', entry, re.IGNORECASE)
    if rel_match:
        rel_text = rel_match.group(1)
        # Split by commas or newlines
        rels = re.split(r'[,\n]', rel_text)
        char.relationships = [r.strip() for r in rels if r.strip()]

    return char


def _parse_events_section(text: str, chapter_id: str) -> list[ParsedEvent]:
    """Parse the ## Timeline & Events section."""
    events = []

    # Look for time markers followed by descriptions
    # Pattern: **Time**: description or Time - description
    lines = text.split("\n")
    current_event = None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        # Check for time marker patterns
        time_match = re.match(r'\*\*([^*]+)\*\*[:\s-]*(.+)?', line)
        if time_match:
            if current_event:
                events.append(current_event)

            when = time_match.group(1).strip()
            desc = time_match.group(2).strip() if time_match.group(2) else ""

            current_event = ParsedEvent(
                description=desc,
                chapter_id=chapter_id,
                when=when,
            )
        elif current_event and line.startswith("-"):
            # Continuation of current event
            current_event.description += " " + line[1:].strip()
        elif current_event:
            current_event.description += " " + line

    if current_event and current_event.description:
        events.append(current_event)

    return events


def _parse_locations_from_facts(text: str, chapter_id: str) -> list[ParsedLocation]:
    """Extract location mentions from Key Facts section."""
    locations = []

    # Look for location-related entries
    # Often formatted as **Location name:** or "Location details:"
    location_patterns = [
        r'\*\*([^*]+(?:Island|Heights|Grange|Pub|House|Mansion|Cave|Lighthouse|Church|Kirk|Village|Town|Harbor|Dock)[^*]*)\*\*[:\s]*([^\n]+)?',
        r'(?:Location|Setting|Place)[s]?[:\s]*([^\n]+)',
    ]

    for pattern in location_patterns:
        matches = re.finditer(pattern, text, re.IGNORECASE)
        for match in matches:
            name = match.group(1).strip()
            desc = match.group(2).strip() if len(match.groups()) > 1 and match.group(2) else ""

            if name and len(name) > 2:
                locations.append(ParsedLocation(
                    name=name,
                    chapter_id=chapter_id,
                    description=desc,
                ))

    return locations


def aggregate_characters(parsed_summaries: list[ParsedSummary]) -> dict[str, list[ParsedCharacter]]:
    """
    Aggregate character mentions across chapters.

    Returns dict mapping normalized character name to list of appearances.
    """
    characters: dict[str, list[ParsedCharacter]] = {}

    for summary in parsed_summaries:
        for char in summary.characters:
            # Normalize name for grouping
            key = _normalize_name(char.name)
            if key not in characters:
                characters[key] = []
            characters[key].append(char)

    return characters


def _normalize_name(name: str) -> str:
    """Normalize a character name for grouping."""
    # Remove titles, parentheticals, lowercase
    name = re.sub(r'^(Mr\.?|Mrs\.?|Ms\.?|Dr\.?|Detective|Captain)\s+', '', name, flags=re.IGNORECASE)
    name = re.sub(r'\s*\([^)]+\)', '', name)
    return name.lower().strip()


def aggregate_locations(parsed_summaries: list[ParsedSummary]) -> dict[str, list[ParsedLocation]]:
    """Aggregate location mentions across chapters."""
    locations: dict[str, list[ParsedLocation]] = {}

    for summary in parsed_summaries:
        for loc in summary.locations:
            key = loc.name.lower().strip()
            if key not in locations:
                locations[key] = []
            locations[key].append(loc)

    return locations
