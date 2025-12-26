"""
Summarizer - generates prose summaries for each chapter.

Replaces the structured JSON extraction with natural prose that's
more robust and easier for the critic to reason about.
"""

import time
from dataclasses import dataclass
from typing import Optional, Callable

import anthropic
from anthropic.types import TextBlock

from critic.types import Chunk
from critic.config import DEFAULT_MODEL


BATCH_POLL_INTERVAL = 5

SUMMARY_PROMPT = """You are analyzing a chapter from a novel. Write a structured summary that captures all important details for continuity checking.

Your summary should be comprehensive but concise (500-1500 words depending on chapter length). Use this structure:

## Characters
List every character who appears or is mentioned. For each:
- Their name (and any aliases used)
- Their role in this chapter (present in scene, mentioned, flashback)
- Physical details mentioned (hair color, height, scars, clothing, etc.)
- Personality traits shown
- Key actions they take
- Relationships mentioned (be specific: "X is Y's sister", "X works for Y")

## Timeline & Events
Describe what happens in chronological order. Be specific about:
- Time references ("Monday morning", "three days later", "that evening")
- The sequence of events
- Where events take place
- Who is involved in each event

## Key Facts
List concrete factual details that could be contradicted later:
- Physical descriptions (the house has 3 bedrooms, the car is blue)
- Backstory revealed (she moved here 5 years ago, he served in the war)
- World details (the town has one hospital, the company was founded in 1985)
- Object details (the letter was written on yellow paper, the key opens the back door)

## Plot Developments
What story threads are touched in this chapter:
- New threads introduced (what question/conflict is raised?)
- Existing threads advanced (what progress is made?)
- Threads complicated (what new obstacles appear?)
- Threads resolved (what questions are answered?)

## Foreshadowing & Setups
Note anything that seems to promise future payoff:
- Objects given emphasis (the gun on the mantle, the mysterious letter)
- Statements that hint at secrets
- Unresolved questions raised

Write in clear, direct prose. Include exact quotes when they contain important details. Be thorough - if something could matter for continuity, include it."""


@dataclass
class ChapterSummary:
    """A prose summary of a chapter."""
    chapter_id: str
    chapter_title: str
    summary: str
    word_count: int


def summarize_chapters(
    chapters: list[Chunk],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> list[ChapterSummary]:
    """
    Generate prose summaries for all chapters using batch API.

    Args:
        chapters: List of chapter chunks
        api_key: Anthropic API key
        model: Model to use
        on_progress: Callback (completed, total)

    Returns:
        List of chapter summaries
    """
    client = anthropic.Anthropic(api_key=api_key)

    print(f"[Summarizer] Generating summaries for {len(chapters)} chapters via batch API")

    # Build batch requests
    batch_requests = []
    for chapter in chapters:
        user_content = f"# {chapter.title}\n\n{chapter.content}" if chapter.title else chapter.content

        batch_requests.append({
            "custom_id": chapter.id,
            "params": {
                "model": model,
                "max_tokens": 4096,
                "system": [
                    {
                        "type": "text",
                        "text": SUMMARY_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    },
                ],
                "messages": [{
                    "role": "user",
                    "content": user_content,
                }],
            },
        })

    # Submit batch
    batch = client.messages.batches.create(requests=batch_requests)
    print(f"[Summarizer] Batch submitted: {batch.id}")

    # Poll for completion
    while batch.processing_status != "ended":
        time.sleep(BATCH_POLL_INTERVAL)
        batch = client.messages.batches.retrieve(batch.id)

        completed = (batch.request_counts.succeeded +
                     batch.request_counts.errored +
                     batch.request_counts.canceled +
                     batch.request_counts.expired)

        if on_progress:
            on_progress(completed, len(chapters))

        print(f"[Summarizer] Progress: {completed}/{len(chapters)} "
              f"(status: {batch.processing_status})")

    print(f"[Summarizer] Batch complete. Succeeded: {batch.request_counts.succeeded}, "
          f"Errored: {batch.request_counts.errored}")

    # Process results
    summaries: dict[str, ChapterSummary] = {}
    chapter_map = {c.id: c for c in chapters}

    for result in client.messages.batches.results(batch.id):
        chapter_id = result.custom_id
        chapter = chapter_map.get(chapter_id)

        if not chapter:
            print(f"[Summarizer] Warning: Unknown chapter ID {chapter_id}")
            continue

        if result.result.type == "succeeded":
            text = ""
            if result.result.message.content and isinstance(result.result.message.content[0], TextBlock):
                text = result.result.message.content[0].text
            summaries[chapter_id] = ChapterSummary(
                chapter_id=chapter_id,
                chapter_title=chapter.title or chapter_id,
                summary=text,
                word_count=len(text.split()),
            )
        else:
            print(f"[Summarizer] Error for {chapter_id}: {result.result.type}")
            # Create placeholder for failed summaries
            summaries[chapter_id] = ChapterSummary(
                chapter_id=chapter_id,
                chapter_title=chapter.title or chapter_id,
                summary="[Summary generation failed for this chapter]",
                word_count=0,
            )

    # Return in original chapter order
    return [summaries[c.id] for c in chapters if c.id in summaries]


def format_manuscript_map(summaries: list[ChapterSummary]) -> str:
    """
    Combine chapter summaries into a full manuscript map.

    This is what the critic will use to understand the whole work.
    """
    parts = []

    for summary in summaries:
        parts.append(f"# {summary.chapter_title}\n\n{summary.summary}")

    return "\n\n---\n\n".join(parts)
