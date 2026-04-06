"""
Document chunker - splits documents into chapters for analysis.

The primary unit of analysis is the chapter. Large chapters are split
into parts, but the goal is to preserve narrative structure.
"""

import re
from dataclasses import dataclass
from typing import Optional

from critic.types import ParsedDocument, Chunk, Heading


# Maximum chapter size before splitting (in characters)
# ~15K chars ≈ 4K tokens - reasonable for a single summary call
MAX_CHAPTER_SIZE = 60000


@dataclass
class Chapter:
    """A chapter detected in the document."""
    title: str
    number: Optional[int]
    start_paragraph: int
    end_paragraph: int
    content: str


def chunk_document(doc: ParsedDocument) -> list[Chunk]:
    """
    Chunk a document into chapters for analysis.

    Strategy:
    1. Detect chapter boundaries from headings
    2. If no chapters found, try to infer from text patterns
    3. Split very large chapters into parts
    4. If still no structure, treat as single chapter

    Args:
        doc: Parsed document

    Returns:
        List of chunks (one per chapter or chapter part)
    """
    chapters = _detect_chapters(doc)

    if not chapters:
        # No chapters detected - treat whole document as one
        chapters = [Chapter(
            title="Full Document",
            number=None,
            start_paragraph=0,
            end_paragraph=len(doc.paragraphs),
            content=doc.full_text,
        )]

    # Convert to chunks, splitting large chapters
    chunks: list[Chunk] = []

    for chapter in chapters:
        if len(chapter.content) <= MAX_CHAPTER_SIZE:
            chunks.append(Chunk(
                id=f"chapter-{len(chunks) + 1}",
                title=chapter.title,
                content=chapter.content,
                start_paragraph=chapter.start_paragraph,
                end_paragraph=chapter.end_paragraph,
            ))
        else:
            # Split large chapter into parts
            parts = _split_chapter(chapter)
            for i, part in enumerate(parts):
                chunks.append(Chunk(
                    id=f"chapter-{len(chunks) + 1}",
                    title=f"{chapter.title} (Part {i + 1})",
                    content=part,
                    start_paragraph=chapter.start_paragraph,
                    end_paragraph=chapter.end_paragraph,
                ))

    return chunks


def _detect_chapters(doc: ParsedDocument) -> list[Chapter]:
    """Detect chapter boundaries from document structure."""

    # Find chapter-level headings
    chapter_headings = [h for h in doc.headings if _is_chapter_heading(h)]

    # Skip title/subtitle headings at the very start
    if chapter_headings and chapter_headings[0].paragraph_index == 0:
        # Check if this looks like a document title vs chapter
        first = chapter_headings[0]
        if not _looks_like_chapter_title(first.text):
            chapter_headings = chapter_headings[1:]

    if not chapter_headings:
        # Try to infer chapters from text patterns
        return _infer_chapters(doc)

    chapters: list[Chapter] = []

    for i, heading in enumerate(chapter_headings):
        # Determine paragraph range
        start_para = heading.paragraph_index
        end_para = (
            chapter_headings[i + 1].paragraph_index
            if i + 1 < len(chapter_headings)
            else len(doc.paragraphs)
        )

        # Handle any content before first chapter
        if i == 0 and heading.paragraph_index > 0:
            preface_content = '\n\n'.join(doc.paragraphs[:heading.paragraph_index])
            if preface_content.strip() and len(preface_content) > 500:
                chapters.append(Chapter(
                    title="Preface",
                    number=0,
                    start_paragraph=0,
                    end_paragraph=heading.paragraph_index,
                    content=preface_content,
                ))

        content = '\n\n'.join(doc.paragraphs[start_para:end_para])

        chapters.append(Chapter(
            title=heading.text,
            number=_extract_chapter_number(heading.text),
            start_paragraph=start_para,
            end_paragraph=end_para,
            content=content,
        ))

    return chapters


def _is_chapter_heading(heading: Heading) -> bool:
    """Check if a heading marks a chapter boundary."""
    # Level 1-2 headings are chapter boundaries
    if heading.level <= 2:
        return True

    # Level 3+ headings only if they look like chapter titles
    text = heading.text.lower().strip()
    chapter_patterns = [
        r'^chapter\s',
        r'^part\s',
        r'^book\s',
        r'^prologue',
        r'^epilogue',
        r'^act\s',
        r'^section\s',
        r'^\d+\.',  # "1.", "2.", etc.
        r'^[ivxlc]+\.',  # Roman numerals
    ]

    return any(re.match(p, text) for p in chapter_patterns)


def _looks_like_chapter_title(text: str) -> bool:
    """Check if text looks like a chapter title vs document title."""
    text = text.lower().strip()
    return bool(re.match(
        r'^(chapter|part|book|prologue|epilogue|act|section|\d+\.|[ivxlc]+\.)',
        text
    ))


def _extract_chapter_number(text: str) -> Optional[int]:
    """Extract chapter number from heading text."""
    # "Chapter 5", "Chapter V", "5.", etc.
    match = re.search(r'(?:chapter\s+)?(\d+)', text, re.IGNORECASE)
    if match:
        return int(match.group(1))

    # Roman numerals
    roman_match = re.search(r'^([IVXLC]+)\.?\s', text, re.IGNORECASE)
    if roman_match:
        return _roman_to_int(roman_match.group(1))

    return None


def _roman_to_int(s: str) -> int:
    """Convert Roman numeral to integer."""
    values = {'I': 1, 'V': 5, 'X': 10, 'L': 50, 'C': 100}
    s = s.upper()
    result = 0
    prev = 0
    for c in reversed(s):
        curr = values.get(c, 0)
        if curr < prev:
            result -= curr
        else:
            result += curr
        prev = curr
    return result


def _infer_chapters(doc: ParsedDocument) -> list[Chapter]:
    """
    Try to infer chapter boundaries from text patterns.

    Looks for:
    - Lines starting with "Chapter X" or similar
    - Significant whitespace gaps
    - Scene break markers (***)
    """
    chapters: list[Chapter] = []
    current_start = 0
    chapter_num = 1

    for i, para in enumerate(doc.paragraphs):
        # Check for chapter-like patterns at start of paragraph
        first_line = para.split('\n')[0].strip()

        if re.match(r'^(chapter|part)\s+\d+', first_line, re.IGNORECASE):
            # Save previous chapter if we have content
            if i > current_start:
                content = '\n\n'.join(doc.paragraphs[current_start:i])
                if content.strip():
                    chapters.append(Chapter(
                        title=f"Chapter {chapter_num}" if chapter_num > 1 else "Opening",
                        number=chapter_num if chapter_num > 1 else 0,
                        start_paragraph=current_start,
                        end_paragraph=i,
                        content=content,
                    ))
                    chapter_num += 1
            current_start = i

    # Add final chapter
    if current_start < len(doc.paragraphs):
        content = '\n\n'.join(doc.paragraphs[current_start:])
        if content.strip():
            chapters.append(Chapter(
                title=f"Chapter {chapter_num}",
                number=chapter_num,
                start_paragraph=current_start,
                end_paragraph=len(doc.paragraphs),
                content=content,
            ))

    return chapters


def _split_chapter(chapter: Chapter) -> list[str]:
    """
    Split a large chapter into parts at natural break points.

    Tries to split at:
    1. Scene breaks (*** or similar)
    2. Paragraph boundaries near target size
    """
    content = chapter.content
    target_size = MAX_CHAPTER_SIZE

    # First try splitting at scene breaks
    scene_breaks = re.split(r'\n\s*[*#-]{3,}\s*\n', content)
    if len(scene_breaks) > 1:
        # Combine small scenes, split large ones
        parts: list[str] = []
        current = ""

        for scene in scene_breaks:
            if len(current) + len(scene) < target_size:
                current = current + "\n\n***\n\n" + scene if current else scene
            else:
                if current:
                    parts.append(current)
                current = scene

        if current:
            parts.append(current)

        return parts

    # Fall back to paragraph-based splitting
    paragraphs = content.split('\n\n')
    parts = []
    current = ""

    for para in paragraphs:
        if len(current) + len(para) > target_size and current:
            parts.append(current)
            current = para
        else:
            current = current + "\n\n" + para if current else para

    if current:
        parts.append(current)

    return parts
