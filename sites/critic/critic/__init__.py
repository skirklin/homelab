"""
Critic - Literary analysis agent for manuscripts

Analyzes manuscripts for continuity errors, character inconsistencies,
plot holes, and more using Claude AI.

New architecture (v2):
1. Parse document
2. Chunk by chapters
3. Generate prose summaries per chapter (batch API)
4. Run critic agent (summaries in context + chapter text retrieval)
"""

from critic.types import (
    ParsedDocument as ParsedDocument,
    Heading as Heading,
    Chunk as Chunk,
)
from critic.schema import (
    AnalysisOutput as AnalysisOutput,
    DocumentInfo as DocumentInfo,
    ChapterInfo as ChapterInfo,
    Issue as Issue,
    Strength as Strength,
    Evidence as Evidence,
    AnalysisSummary as AnalysisSummary,
    TokenUsage as TokenUsage,
)
from critic.parser import parse_document as parse_document, parse_text as parse_text
from critic.chunker import chunk_document as chunk_document
from critic.summarizer import (
    summarize_chapters as summarize_chapters,
    ChapterSummary as ChapterSummary,
)
from critic.analyzer import analyze_document as analyze_document
from critic.critic import (
    run_critic as run_critic,
    CriticResult as CriticResult,
)

__version__ = "0.2.0"
