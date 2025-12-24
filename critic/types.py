"""
Basic types for document parsing and chunking.
"""

from dataclasses import dataclass
from typing import Optional


@dataclass
class Heading:
    """A heading found in the document."""
    text: str
    level: int  # 1 = h1, 2 = h2, etc.
    paragraph_index: int


@dataclass
class ParsedDocument:
    """Result of parsing a document."""
    title: str
    paragraphs: list[str]
    headings: list[Heading]
    full_text: str

    @property
    def word_count(self) -> int:
        return len(self.full_text.split())


@dataclass
class Chunk:
    """A section of the document for analysis."""
    id: str
    title: Optional[str]
    content: str
    start_paragraph: int = 0
    end_paragraph: int = 0
