"""
Discovery pass - identifies all characters and plot threads across the document.

This quick first pass provides context for the detailed extraction pass.
"""

import json
import re
from dataclasses import dataclass, field
from typing import Callable, Optional

import anthropic

from critic.types import Chunk
from critic.retry import retry_api_call
from critic.config import DEFAULT_MODEL


@dataclass
class DiscoveredCharacter:
    """A character discovered in the manuscript."""
    name: str
    aliases: list[str] = field(default_factory=list)
    description: Optional[str] = None


@dataclass
class DiscoveredThread:
    """A plot thread discovered in the manuscript."""
    name: str
    description: str
    central_question: Optional[str] = None


@dataclass
class DiscoveredEntities:
    """All entities discovered in the manuscript."""
    characters: list[DiscoveredCharacter] = field(default_factory=list)
    plot_threads: list[DiscoveredThread] = field(default_factory=list)
    locations: list[str] = field(default_factory=list)


@dataclass
class DiscoveryResult:
    """Result of the discovery pass."""
    entities: DiscoveredEntities
    token_usage: dict  # {input_tokens, output_tokens}


DISCOVERY_PROMPT = """You are analyzing a novel manuscript to identify all characters and plot threads.

Scan the text and identify:

## Characters
List every character that appears or is mentioned. For each character:
- name: Their primary name (most formal/complete version)
- aliases: Other names they're called (nicknames, titles, first name only, etc.)
- description: Brief one-line description if apparent

## Plot Threads
Identify the main storylines/threads. A plot thread is a narrative arc with a central question or conflict. For each:
- name: Brief name (e.g., "Emma Hartley murder investigation")
- description: What the thread is about
- centralQuestion: The question driving this thread (e.g., "Who killed Emma Hartley?")

## Locations
List the main locations/settings mentioned.

Return as JSON:
{
  "characters": [
    {"name": "...", "aliases": ["...", "..."], "description": "..."}
  ],
  "plotThreads": [
    {"name": "...", "description": "...", "centralQuestion": "..."}
  ],
  "locations": ["...", "..."]
}

Focus on being comprehensive - it's better to include minor characters than miss important ones."""


def discover_entities(
    chunks: list[Chunk],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> DiscoveryResult:
    """
    Run discovery pass across all chunks to identify entities.

    Args:
        chunks: Document chunks to analyze
        api_key: Anthropic API key (uses ANTHROPIC_API_KEY env var if not provided)
        model: Model to use
        on_progress: Callback for progress updates (completed, total)

    Returns:
        DiscoveryResult with discovered entities and token usage
    """
    client = anthropic.Anthropic(api_key=api_key)

    # Combine chunks into segments for efficiency (5 chunks at a time)
    segment_size = 5
    segments: list[str] = []

    for i in range(0, len(chunks), segment_size):
        segment_chunks = chunks[i:i + segment_size]
        segment = '\n\n---\n\n'.join(
            f"## {c.title}\n\n{c.content}" if c.title else c.content
            for c in segment_chunks
        )
        segments.append(segment)

    # Process segments
    all_results: list[DiscoveredEntities] = []
    total_input_tokens = 0
    total_output_tokens = 0

    for i, segment in enumerate(segments):
        result, usage = _discover_from_segment(client, model, segment)
        all_results.append(result)
        total_input_tokens += usage['input_tokens']
        total_output_tokens += usage['output_tokens']

        if on_progress:
            on_progress(i + 1, len(segments))

    # Merge all discoveries
    merged = _merge_discoveries(all_results)

    return DiscoveryResult(
        entities=merged,
        token_usage={
            'input_tokens': total_input_tokens,
            'output_tokens': total_output_tokens,
        },
    )


def _discover_from_segment(
    client: anthropic.Anthropic,
    model: str,
    segment: str,
) -> tuple[DiscoveredEntities, dict]:
    """Discover entities from a single segment."""
    # Use streaming to avoid timeout issues with long requests
    text_parts: list[str] = []
    response = None

    def make_request():
        nonlocal text_parts, response
        text_parts = []  # Reset on retry

        with client.messages.stream(
            model=model,
            max_tokens=16384,
            messages=[{
                'role': 'user',
                'content': f"{DISCOVERY_PROMPT}\n\n---\n\nTEXT TO ANALYZE:\n\n{segment}",
            }],
        ) as stream:
            for text_chunk in stream.text_stream:
                text_parts.append(text_chunk)
            response = stream.get_final_message()

    def on_retry(attempt, delay, _exc):
        print(f"  Rate limited during discovery, waiting {delay:.0f}s (attempt {attempt})...")

    retry_api_call(make_request, on_retry=on_retry)

    text = ''.join(text_parts)
    entities = _parse_discovery_response(text)

    assert response is not None  # Set by make_request
    return entities, {
        'input_tokens': response.usage.input_tokens,
        'output_tokens': response.usage.output_tokens,
    }


def _parse_discovery_response(text: str) -> DiscoveredEntities:
    """Parse the discovery response JSON."""
    empty = DiscoveredEntities()

    try:
        # Try to extract JSON from code block
        code_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
        if code_match:
            data = json.loads(code_match.group(1).strip())
        else:
            # Try to find raw JSON
            json_match = re.search(r'\{[\s\S]*\}', text)
            if json_match:
                data = json.loads(json_match.group(0))
            else:
                return empty

        characters = [
            DiscoveredCharacter(
                name=c.get('name', ''),
                aliases=c.get('aliases', []),
                description=c.get('description'),
            )
            for c in data.get('characters', [])
        ]

        threads = [
            DiscoveredThread(
                name=t.get('name', ''),
                description=t.get('description', ''),
                central_question=t.get('centralQuestion'),
            )
            for t in data.get('plotThreads', [])
        ]

        locations = data.get('locations', [])

        return DiscoveredEntities(
            characters=characters,
            plot_threads=threads,
            locations=locations,
        )

    except (json.JSONDecodeError, KeyError) as e:
        print(f"Failed to parse discovery response: {e}")
        return empty


def _merge_discoveries(results: list[DiscoveredEntities]) -> DiscoveredEntities:
    """Merge multiple discovery results, deduplicating entities."""
    char_map: dict[str, DiscoveredCharacter] = {}
    thread_map: dict[str, DiscoveredThread] = {}
    location_set: set[str] = set()

    for result in results:
        # Merge characters
        for char in result.characters:
            key = _find_matching_character(char.name, char_map)
            if key:
                existing = char_map[key]
                # Merge aliases
                for alias in char.aliases:
                    if alias.lower() not in [a.lower() for a in existing.aliases]:
                        if alias.lower() != existing.name.lower():
                            existing.aliases.append(alias)
                # Use longer description
                if char.description and (
                    not existing.description or
                    len(char.description) > len(existing.description)
                ):
                    existing.description = char.description
            else:
                char_map[char.name.lower()] = DiscoveredCharacter(
                    name=char.name,
                    aliases=char.aliases.copy(),
                    description=char.description,
                )

        # Merge plot threads
        for thread in result.plot_threads:
            key = _find_matching_thread(thread.name, thread_map)
            if key:
                existing = thread_map[key]
                if len(thread.description) > len(existing.description):
                    existing.description = thread.description
                if thread.central_question and not existing.central_question:
                    existing.central_question = thread.central_question
            else:
                thread_map[thread.name.lower()] = DiscoveredThread(
                    name=thread.name,
                    description=thread.description,
                    central_question=thread.central_question,
                )

        # Merge locations
        location_set.update(result.locations)

    return DiscoveredEntities(
        characters=list(char_map.values()),
        plot_threads=list(thread_map.values()),
        locations=list(location_set),
    )


def _find_matching_character(
    name: str,
    char_map: dict[str, DiscoveredCharacter],
) -> Optional[str]:
    """Find a matching character in the map."""
    normalized = name.lower()

    # Exact match
    if normalized in char_map:
        return normalized

    # Check aliases
    for key, char in char_map.items():
        if any(a.lower() == normalized for a in char.aliases):
            return key

        # Partial name match
        name_parts = set(normalized.split())
        key_parts = set(key.split())
        if name_parts & key_parts and any(len(p) > 2 for p in name_parts & key_parts):
            return key

    return None


def _find_matching_thread(
    name: str,
    thread_map: dict[str, DiscoveredThread],
) -> Optional[str]:
    """Find a matching thread in the map."""
    normalized = name.lower()

    if normalized in thread_map:
        return normalized

    # Check word overlap
    words = {w for w in normalized.split() if len(w) > 3}

    for key in thread_map:
        key_words = {w for w in key.split() if len(w) > 3}
        overlap = len(words & key_words)
        if overlap >= 2:
            return key

    return None


def format_discovered_context(entities: DiscoveredEntities) -> str:
    """Format discovered entities for inclusion in extraction prompt."""
    lines = []

    lines.append("## Known Characters")
    lines.append("These characters have been identified in the manuscript. Match mentions to this list:")
    for char in entities.characters:
        aliases = f" (also: {', '.join(char.aliases)})" if char.aliases else ""
        desc = f" - {char.description}" if char.description else ""
        lines.append(f"- {char.name}{aliases}{desc}")

    lines.append("")
    lines.append("## Known Plot Threads")
    lines.append("These are the main storylines. When you see these threads touched, identify if they are advanced, complicated, or resolved:")
    for thread in entities.plot_threads:
        question = f" (Central question: {thread.central_question})" if thread.central_question else ""
        lines.append(f'- "{thread.name}": {thread.description}{question}')

    if entities.locations:
        lines.append("")
        lines.append("## Known Locations")
        lines.append(", ".join(entities.locations))

    return "\n".join(lines)
