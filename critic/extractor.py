"""
Extractor - extracts structured information from each chunk.

This is the detailed extraction pass that runs after discovery.
"""

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Optional, TYPE_CHECKING

import anthropic

from critic.types import Chunk
from critic.retry import retry_api_call
from critic.schema import (
    ChunkWithText,
    ChunkExtraction,
    EventExtraction,
    CharacterMention,
    FactExtraction,
    PlotThreadTouch,
    SetupExtraction,
    DialogueLine,
    SceneBreak,
    TextLocation,
)
from critic.discovery import DiscoveredEntities, format_discovered_context

if TYPE_CHECKING:
    from critic.cache import AnalysisCache

from critic.config import DEFAULT_MODEL


def build_extraction_prompt(discovered_context: Optional[str] = None) -> str:
    """Build the extraction prompt, optionally with discovered entity context."""
    context_section = ""
    if discovered_context:
        context_section = f"""
# DOCUMENT CONTEXT
The following characters and plot threads have been identified in this manuscript. Use these as reference when extracting:

{discovered_context}

---
"""

    character_instructions = """For each character that appears or is mentioned:
- name: Character's name (use the canonical name from the known characters list if they match)
- role: "present" (in the scene), "mentioned" (talked about), or "flashback"
- attributes: Array of character details. For each attribute:
  - value: The attribute (e.g., "blue eyes", "detective", "nervous")
  - category: One of:
    - "physical": Stable physical traits (eye color, height, scars, age)
    - "personality": Stable personality traits (determined, kind, suspicious)
    - "occupation": Job or role (detective, fisherman, bartender)
    - "action": Momentary actions (clutching coffee, leaning forward) - SKIP THESE, don't include actions
  IMPORTANT: Only include stable traits (physical, personality, occupation). Skip momentary actions.
- relationships: Array of relationships FROM THIS CHARACTER'S PERSPECTIVE. Format: {target: "other character name", relationship: "what the target is TO this character"}
  IMPORTANT: The relationship describes what the TARGET is to the SOURCE character.
  Examples: If Alice's mother is named Beth, Alice's relationship entry is {target: "Beth", relationship: "mother"} (Beth is Alice's mother).
- quote: A quote showing their appearance/mention"""

    thread_instructions = """Story threads touched in this section. Match to known threads when possible. A thread is resolved when its central question/conflict is answered/concluded.
- name: Use the exact name from the known plot threads list if this section touches that thread
- action: "introduced" (new thread), "advanced" (progress made), "complicated" (new obstacle/twist), or "resolved" (concluded)
- description: What happened with this thread in this section
- quote: Relevant quote"""

    return f"""You are analyzing a section of a novel manuscript. Extract structured information with EXACT QUOTES from the text.
{context_section}
For each item you extract, you MUST include:
1. The exact quote from the text (verbatim, word-for-word)
2. This quote will be used to locate the text in the original document, so accuracy is critical

Analyze the text and extract:

## 1. Events (things that happen)
For each significant event:
- description: What happened
- timeMarker: Quote ANY time reference from the text. Look for:
  * Explicit times: "Monday morning", "3pm", "January 5th"
  * Relative times: "three days later", "the next morning", "after dinner"
  * Vague times: "that evening", "later", "soon after"
  * Scene context: "during the meeting", "while driving home"
  * If truly no time reference, use "continuing" (same scene as previous) or "scene break" (new scene, time unclear)
- precision: "exact" (specific date/time), "relative" (e.g., "three days later"), or "vague" (e.g., "that morning")
- sequenceNote: What narrative context surrounds this?
- characters: Names of characters involved
- quote: The EXACT sentence(s) describing this event

## 2. Character Appearances
{character_instructions}

## 3. Facts Established
Concrete details that could be contradicted later:
- content: The fact
- category: "character", "world", "location", "object", "relationship", or "other"
- subject: What/who it's about
- quote: EXACT quote establishing this fact

## 4. Plot Threads
{thread_instructions}

## 5. Setups/Foreshadowing
Things that seem to promise future payoff:
- description: What was set up
- weight: "subtle", "moderate", or "heavy"
- impliedPayoff: What this seems to promise
- quote: The setup text

## 6. Dialogue (important conversations only)
For significant dialogue exchanges that reveal character or advance plot:
- speaker: Who is speaking
- target: Who they're speaking to (if clear)
- summary: Brief summary of what they said (2-3 sentences max)
- tone: The emotional tone (e.g., "angry", "pleading", "casual", "threatening")
- reveals: Array of key information revealed in this dialogue
- quote: A key quote from this dialogue

## 7. Scene Structure
When the scene changes (location, time, or POV shift):
- sceneNumber: Number starting from 1 within this chapter
- location: Where the scene takes place
- time: Time reference for this scene (if mentioned)
- charactersPresent: Array of characters in the scene
- povCharacter: Whose perspective we're seeing (if clear)

## 8. Open Questions
Mysteries or questions raised for the reader (just list as strings)

Return as JSON:
{{
  "events": [...],
  "characters": [...],
  "facts": [...],
  "plotThreads": [...],
  "setups": [...],
  "dialogue": [...],
  "scenes": [...],
  "openQuestions": [...]
}}

CRITICAL: Every quote must be EXACTLY as it appears in the text. Do not paraphrase."""


def extract_from_chunks(
    chunks: list[Chunk],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    discovered_entities: Optional[DiscoveredEntities] = None,
    cache: Optional["AnalysisCache"] = None,
    concurrency: int = 3,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
) -> tuple[list[ChunkWithText], dict]:
    """
    Extract structured data from chunks with source locations.

    Args:
        chunks: Document chunks to extract from
        api_key: Anthropic API key
        model: Model to use
        discovered_entities: Pre-discovered entities for context
        cache: Optional cache for extraction results
        concurrency: Number of parallel extractions
        on_progress: Callback (completed, total, chunk_id)

    Returns:
        Tuple of (chunks_with_text, token_usage)
    """
    client = anthropic.Anthropic(api_key=api_key)

    # Build prompt with discovered context
    discovered_context = (
        format_discovered_context(discovered_entities)
        if discovered_entities else None
    )
    extraction_prompt = build_extraction_prompt(discovered_context)

    # Hash for cache key
    entities_hash = ""
    if discovered_entities and cache:
        entities_hash = cache.hash_discovered_entities(discovered_entities)

    results: list[Optional[ChunkWithText]] = [None] * len(chunks)
    token_usage = {'input_tokens': 0, 'output_tokens': 0}
    completed = 0

    # Calculate offsets
    current_offset = 0
    offsets = []
    for chunk in chunks:
        offsets.append(current_offset)
        current_offset += len(chunk.content) + 1

    # Check cache for each chunk
    uncached_indices = []
    for i, chunk in enumerate(chunks):
        if cache:
            cached = cache.get_extraction(chunk.content, chunk.id, model, entities_hash)
            if cached:
                extraction, usage = cached
                results[i] = ChunkWithText(
                    id=chunk.id,
                    title=chunk.title,
                    text=chunk.content,
                    start_offset=offsets[i],
                    end_offset=offsets[i] + len(chunk.content),
                    extraction=extraction,
                )
                token_usage['input_tokens'] += usage['input_tokens']
                token_usage['output_tokens'] += usage['output_tokens']
                completed += 1
                if on_progress:
                    on_progress(completed, len(chunks), chunk.id)
                continue
        uncached_indices.append(i)

    if uncached_indices:
        print(f"[Extractor] Processing {len(uncached_indices)} uncached chunks "
              f"({len(chunks) - len(uncached_indices)} from cache)")

    # Process uncached chunks with thread pool
    def process_chunk(idx: int) -> tuple[int, ChunkWithText, dict]:
        chunk = chunks[idx]
        result, usage = _extract_from_chunk(
            client, model, chunk, offsets[idx], extraction_prompt
        )

        # Save to cache
        if cache:
            cache.set_extraction(
                chunk.content, model, entities_hash,
                result.extraction, usage
            )

        return idx, result, usage

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {
            executor.submit(process_chunk, idx): idx
            for idx in uncached_indices
        }

        for future in as_completed(futures):
            idx, result, usage = future.result()
            results[idx] = result
            token_usage['input_tokens'] += usage['input_tokens']
            token_usage['output_tokens'] += usage['output_tokens']
            completed += 1
            if on_progress:
                on_progress(completed, len(chunks), chunks[idx].id)

    return [r for r in results if r is not None], token_usage


def _extract_from_chunk(
    client: anthropic.Anthropic,
    model: str,
    chunk: Chunk,
    start_offset: int,
    extraction_prompt: str,
) -> tuple[ChunkWithText, dict]:
    """Extract from a single chunk."""
    chunk_context = (
        f"## Section: {chunk.title}\n\n{chunk.content}"
        if chunk.title else chunk.content
    )

    # Use streaming to avoid timeout issues with long requests
    text_parts = []
    input_tokens = 0
    output_tokens = 0
    stop_reason = None

    def make_request():
        nonlocal text_parts, input_tokens, output_tokens, stop_reason
        text_parts = []  # Reset on retry

        with client.messages.stream(
            model=model,
            max_tokens=64000,
            messages=[{
                'role': 'user',
                'content': f"{extraction_prompt}\n\n---\n\nTEXT TO ANALYZE:\n\n{chunk_context}",
            }],
        ) as stream:
            for text_chunk in stream.text_stream:
                text_parts.append(text_chunk)
            response = stream.get_final_message()
            input_tokens = response.usage.input_tokens
            output_tokens = response.usage.output_tokens
            stop_reason = response.stop_reason

    def on_retry(attempt, delay, exc):
        print(f"  Rate limited on chunk {chunk.id}, waiting {delay:.0f}s (attempt {attempt})...")

    retry_api_call(make_request, on_retry=on_retry)

    if stop_reason == 'max_tokens':
        print(f"Warning: Extraction for chunk {chunk.id} was truncated")

    text = ''.join(text_parts)

    raw = _parse_json_response(text, chunk.id)
    extraction = _process_raw_extraction(raw, chunk)

    return ChunkWithText(
        id=chunk.id,
        title=chunk.title,
        text=chunk.content,
        start_offset=start_offset,
        end_offset=start_offset + len(chunk.content),
        extraction=extraction,
    ), {
        'input_tokens': input_tokens,
        'output_tokens': output_tokens,
    }


def _normalize_attribute(a: Any) -> Optional[dict]:
    """Normalize an attribute to {value, category} dict. Returns None for actions."""
    if isinstance(a, str):
        # Legacy format - treat as unknown category
        return {"value": a, "category": "state"}
    if isinstance(a, dict):
        category = a.get('category', 'state')
        # Skip actions - they're momentary, not stable traits
        if category == 'action':
            return None
        value = a.get('value') or a.get('attribute') or a.get('name', '')
        if value:
            return {"value": value, "category": category}
    return None


def _process_raw_extraction(raw: dict, chunk: Chunk) -> ChunkExtraction:
    """Process raw extraction and add text locations."""

    def loc(quote: str) -> TextLocation:
        return _find_text_location(quote, chunk.content, chunk.id)

    def make_id(prefix: str, i: int) -> str:
        return f"{chunk.id}-{prefix}-{i}"

    # Process events
    events = [
        EventExtraction(
            id=make_id("event", i),
            description=e.get('description', ''),
            time_marker=e.get('timeMarker', ''),
            precision=e.get('precision', 'vague'),
            sequence_note=e.get('sequenceNote'),
            character_ids=[],
            location=loc(e.get('quote', '')),
        )
        for i, e in enumerate(raw.get('events', []))
    ]

    # Process characters (needs special handling for attributes)
    character_mentions = []
    for c in raw.get('characters', []):
        # Normalize attributes - filter out actions, keep stable traits
        attrs = [a for a in (_normalize_attribute(x) for x in c.get('attributes', [])) if a]
        character_mentions.append(CharacterMention(
            character_id='',
            name=c.get('name', ''),
            role=c.get('role', 'present'),
            location=loc(c.get('quote', '')),
            # Store as list of dicts with value and category
            attributes_mentioned=attrs,
            relationships_mentioned=[
                {'target': r.get('target', ''), 'relationship': r.get('relationship', '')}
                for r in c.get('relationships', [])
            ],
        ))

    # Process facts
    facts = [
        FactExtraction(
            id=make_id("fact", i),
            content=f.get('content', ''),
            category=f.get('category', 'other'),
            subject=f.get('subject', ''),
            location=loc(f.get('quote', '')),
        )
        for i, f in enumerate(raw.get('facts', []))
    ]

    # Process plot threads
    plot_threads = [
        PlotThreadTouch(
            thread_id='',
            name=pt.get('name', ''),
            action=pt.get('action', 'advanced'),
            description=pt.get('description', ''),
            location=loc(pt.get('quote', '')),
        )
        for pt in raw.get('plotThreads', [])
    ]

    # Process setups
    setups = [
        SetupExtraction(
            id=make_id("setup", i),
            description=s.get('description', ''),
            weight=s.get('weight', 'moderate'),
            implied_payoff=s.get('impliedPayoff', ''),
            location=loc(s.get('quote', '')),
            status='pending',
        )
        for i, s in enumerate(raw.get('setups', []))
    ]

    # Process dialogue
    dialogue = [
        DialogueLine(
            speaker=d.get('speaker', ''),
            target=d.get('target'),
            summary=d.get('summary', ''),
            tone=d.get('tone'),
            reveals=d.get('reveals', []),
            location=loc(d.get('quote', '')),
        )
        for d in raw.get('dialogue', [])
    ]

    # Process scenes
    scenes = []
    for s in raw.get('scenes', []):
        scene_loc = loc(s.get('location', '') or s.get('time', ''))
        scenes.append(SceneBreak(
            scene_number=s.get('sceneNumber', len(scenes) + 1),
            location=s.get('location'),
            time=s.get('time'),
            characters_present=s.get('charactersPresent', []),
            pov_character=s.get('povCharacter'),
            start_offset=scene_loc.start_offset,
            end_offset=scene_loc.end_offset,
        ))

    return ChunkExtraction(
        events=events,
        character_mentions=character_mentions,
        facts=facts,
        plot_threads=plot_threads,
        setups=setups,
        dialogue=dialogue,
        scenes=scenes,
        open_questions=raw.get('openQuestions', []),
    )


def _find_text_location(quote: str, chunk_text: str, chunk_id: str) -> TextLocation:
    """Find the location of a quote in the chunk text."""
    # Try exact match
    start = chunk_text.find(quote)

    # Try case-insensitive
    if start == -1:
        start = chunk_text.lower().find(quote.lower())

    # Try fuzzy match
    if start == -1:
        start = _fuzzy_find_quote(quote, chunk_text)

    if start != -1:
        end = start + len(quote)
        return TextLocation(
            chunk_id=chunk_id,
            start_offset=start,
            end_offset=end,
            snippet=chunk_text[start:end],
            human_readable=_get_human_readable_location(chunk_text, start),
        )

    # Fallback
    return TextLocation(
        chunk_id=chunk_id,
        start_offset=0,
        end_offset=min(len(quote), len(chunk_text)),
        snippet=quote,
        human_readable="Location approximate",
    )


def _fuzzy_find_quote(quote: str, text: str) -> int:
    """Fuzzy find a quote in text."""
    def normalize(s: str) -> str:
        return re.sub(r'[^\w\s]', '', s.lower()).strip()

    normalized_quote = normalize(quote)
    normalized_text = normalize(text)

    # Try normalized version
    idx = normalized_text.find(normalized_quote)
    if idx != -1:
        ratio = idx / len(normalized_text) if normalized_text else 0
        return int(ratio * len(text))

    # Try first few words
    words = normalized_quote.split()[:5]
    if len(words) >= 3:
        partial = ' '.join(words)
        idx = normalized_text.find(partial)
        if idx != -1:
            ratio = idx / len(normalized_text) if normalized_text else 0
            return int(ratio * len(text))

    return -1


def _get_human_readable_location(text: str, offset: int) -> str:
    """Get human-readable location."""
    before = text[:offset]
    paragraphs = before.split('\n\n')
    return f"Paragraph {len(paragraphs)}"


def _parse_json_response(text: str, chunk_id: str = "") -> dict:
    """Parse JSON from Claude's response."""
    # Try code block
    code_match = re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if code_match:
        try:
            return json.loads(code_match.group(1).strip())
        except json.JSONDecodeError as e:
            print(f"JSON parse error in code block for {chunk_id}: {e}")

    # Try raw JSON
    json_match = re.search(r'\{[\s\S]*\}', text)
    if json_match:
        try:
            return json.loads(json_match.group(0))
        except json.JSONDecodeError as e:
            print(f"JSON parse error for {chunk_id}: {e}")
            print(f"JSON snippet: {json_match.group(0)[:200]}...")

    print(f"Failed to extract JSON from response for {chunk_id}")
    return {}
