"""
Critic - Literary analysis agent for manuscripts

Analyzes manuscripts for continuity errors, character inconsistencies,
plot holes, and more using Claude AI.
"""

from .types import (
    ParsedDocument as ParsedDocument,
    Heading as Heading,
    Chunk as Chunk,
)
from .schema import (
    AnalysisOutput as AnalysisOutput,
    DocumentInfo as DocumentInfo,
    ChunkWithText as ChunkWithText,
    ChunkExtraction as ChunkExtraction,
    EventExtraction as EventExtraction,
    CharacterMention as CharacterMention,
    FactExtraction as FactExtraction,
    PlotThreadTouch as PlotThreadTouch,
    SetupExtraction as SetupExtraction,
    TextLocation as TextLocation,
    EntityIndex as EntityIndex,
    CharacterEntity as CharacterEntity,
    CharacterAttribute as CharacterAttribute,
    CharacterAppearance as CharacterAppearance,
    CharacterRelationship as CharacterRelationship,
    LocationEntity as LocationEntity,
    ObjectEntity as ObjectEntity,
    PlotThreadView as PlotThreadView,
    PlotThreadEvent as PlotThreadEvent,
    TimelineView as TimelineView,
    TimelineEvent as TimelineEvent,
    TimelineInconsistency as TimelineInconsistency,
    TimeSpan as TimeSpan,
    IssueWithContext as IssueWithContext,
    IssueType as IssueType,
    EvidenceItem as EvidenceItem,
    AnalysisSummary as AnalysisSummary,
    TokenUsage as TokenUsage,
)
from .parser import parse_document as parse_document, parse_text as parse_text
from .chunker import chunk_document as chunk_document, estimate_tokens as estimate_tokens
from .discovery import (
    discover_entities as discover_entities,
    DiscoveryResult as DiscoveryResult,
    DiscoveredEntities as DiscoveredEntities,
)
from .analyzer import analyze_document as analyze_document
from .cache import AnalysisCache as AnalysisCache
from .critic import (
    run_critic as run_critic,
    insights_to_issues as insights_to_issues,
    CriticInsight as CriticInsight,
    CriticIssue as CriticIssue,
)

__version__ = "0.1.0"
