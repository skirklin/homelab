"""
Document chunker - splits documents into analyzable sections.
"""

from typing import Literal, Optional
from dataclasses import dataclass

from critic.types import ParsedDocument, Chunk, Heading


@dataclass
class ChunkOptions:
    """Options for chunking."""
    strategy: Literal["chapters", "size", "hybrid"] = "hybrid"
    target_size: int = 8000  # characters
    min_size: int = 2000
    max_size: int = 15000


def estimate_tokens(text: str) -> int:
    """
    Estimate token count for text.
    Rough approximation: ~4 characters per token for English.
    """
    return len(text) // 4


def chunk_document(
    doc: ParsedDocument,
    options: Optional[ChunkOptions] = None,
) -> list[Chunk]:
    """
    Chunk a document into sections for analysis.

    Args:
        doc: Parsed document
        options: Chunking options

    Returns:
        List of chunks
    """
    opts = options or ChunkOptions()

    if opts.strategy == "chapters":
        return _chunk_by_chapters(doc, opts)
    elif opts.strategy == "size":
        return _chunk_by_size(doc, opts)
    else:  # hybrid
        return _chunk_hybrid(doc, opts)


def _is_chapter_heading(heading: Heading) -> bool:
    """Check if a heading is a chapter boundary."""
    # Level 1-2 headings are always chapter boundaries
    if heading.level <= 2:
        return True
    # Level 3 headings that look like chapter titles
    text_lower = heading.text.lower()
    if heading.level == 3 and (
        text_lower.startswith('chapter') or
        text_lower.startswith('epilogue') or
        text_lower.startswith('prologue') or
        text_lower.startswith('part ')
    ):
        return True
    return False


def _chunk_by_chapters(doc: ParsedDocument, opts: ChunkOptions) -> list[Chunk]:
    """Chunk by chapter headings."""
    if not doc.headings:
        # No headings, fall back to size-based
        return _chunk_by_size(doc, opts)

    # Find chapter-level headings
    chapter_headings = [h for h in doc.headings if _is_chapter_heading(h)]

    # Skip title/subtitle headings at the start (paragraph 0)
    chapter_headings = [h for h in chapter_headings if h.paragraph_index > 0]

    if not chapter_headings:
        return _chunk_by_size(doc, opts)

    chunks: list[Chunk] = []

    for i, heading in enumerate(chapter_headings):
        # For first chunk, include any content before the first chapter heading
        start_para = 0 if i == 0 else heading.paragraph_index
        end_para = (
            chapter_headings[i + 1].paragraph_index
            if i + 1 < len(chapter_headings)
            else len(doc.paragraphs)
        )

        content = '\n\n'.join(doc.paragraphs[start_para:end_para])

        chunks.append(Chunk(
            id=f"chunk-{i + 1}",
            title=heading.text,
            content=content,
            start_paragraph=start_para,
            end_paragraph=end_para,
        ))

    return chunks


def _chunk_by_size(doc: ParsedDocument, opts: ChunkOptions) -> list[Chunk]:
    """Chunk by target size."""
    chunks: list[Chunk] = []
    current_content: list[str] = []
    current_size = 0
    start_para = 0
    chunk_num = 1

    for i, para in enumerate(doc.paragraphs):
        para_size = len(para)

        # Check if adding this paragraph would exceed max size
        if current_size + para_size > opts.max_size and current_content:
            # Save current chunk
            chunks.append(Chunk(
                id=f"chunk-{chunk_num}",
                title=None,
                content='\n\n'.join(current_content),
                start_paragraph=start_para,
                end_paragraph=i,
            ))
            chunk_num += 1
            current_content = []
            current_size = 0
            start_para = i

        current_content.append(para)
        current_size += para_size

        # Check if we've reached target size
        if current_size >= opts.target_size:
            chunks.append(Chunk(
                id=f"chunk-{chunk_num}",
                title=None,
                content='\n\n'.join(current_content),
                start_paragraph=start_para,
                end_paragraph=i + 1,
            ))
            chunk_num += 1
            current_content = []
            current_size = 0
            start_para = i + 1

    # Don't forget remaining content
    if current_content:
        chunks.append(Chunk(
            id=f"chunk-{chunk_num}",
            title=None,
            content='\n\n'.join(current_content),
            start_paragraph=start_para,
            end_paragraph=len(doc.paragraphs),
        ))

    return chunks


def _chunk_hybrid(doc: ParsedDocument, opts: ChunkOptions) -> list[Chunk]:
    """
    Hybrid chunking: respect chapter boundaries but split large chapters.
    """
    # First, get chapter-based chunks
    chapter_chunks = _chunk_by_chapters(doc, opts)

    if not chapter_chunks:
        return _chunk_by_size(doc, opts)

    # Split any chunks that are too large
    final_chunks: list[Chunk] = []
    chunk_num = 1

    for chapter in chapter_chunks:
        if len(chapter.content) <= opts.max_size:
            final_chunks.append(Chunk(
                id=f"chunk-{chunk_num}",
                title=chapter.title,
                content=chapter.content,
                start_paragraph=chapter.start_paragraph,
                end_paragraph=chapter.end_paragraph,
            ))
            chunk_num += 1
        else:
            # Split this chapter
            sub_chunks = _split_large_chunk(chapter, opts, chunk_num)
            final_chunks.extend(sub_chunks)
            chunk_num += len(sub_chunks)

    return final_chunks


def _split_large_chunk(
    chunk: Chunk,
    opts: ChunkOptions,
    start_num: int,
) -> list[Chunk]:
    """Split a large chunk into smaller pieces."""
    paragraphs = chunk.content.split('\n\n')
    sub_chunks: list[Chunk] = []
    current_content: list[str] = []
    current_size = 0
    sub_num = 1

    for para in paragraphs:
        para_size = len(para)

        if current_size + para_size > opts.target_size and current_content:
            sub_chunks.append(Chunk(
                id=f"chunk-{start_num + sub_num - 1}",
                title=f"{chunk.title} (Part {sub_num})" if chunk.title else None,
                content='\n\n'.join(current_content),
                start_paragraph=chunk.start_paragraph,
                end_paragraph=chunk.end_paragraph,
            ))
            sub_num += 1
            current_content = []
            current_size = 0

        current_content.append(para)
        current_size += para_size

    if current_content:
        sub_chunks.append(Chunk(
            id=f"chunk-{start_num + sub_num - 1}",
            title=f"{chunk.title} (Part {sub_num})" if chunk.title else None,
            content='\n\n'.join(current_content),
            start_paragraph=chunk.start_paragraph,
            end_paragraph=chunk.end_paragraph,
        ))

    return sub_chunks
