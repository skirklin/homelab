"""
Critic - Literary analysis agent for manuscripts

Analyzes manuscripts for continuity errors, character inconsistencies,
plot holes, and more using Claude AI.
"""

from critic.types import (
    ParsedDocument as ParsedDocument,
    Heading as Heading,
    Chunk as Chunk,
)
from critic.schema import (
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
    TimeAnchor as TimeAnchor,
    EntityTimeline as EntityTimeline,
    CharacterProfile as CharacterProfile,
    DialogueLine as DialogueLine,
    SceneBreak as SceneBreak,
    IssueWithContext as IssueWithContext,
    IssueType as IssueType,
    EvidenceItem as EvidenceItem,
    AnalysisSummary as AnalysisSummary,
    TokenUsage as TokenUsage,
)
from critic.parser import parse_document as parse_document, parse_text as parse_text
from critic.chunker import chunk_document as chunk_document, estimate_tokens as estimate_tokens
from critic.discovery import (
    discover_entities as discover_entities,
    DiscoveryResult as DiscoveryResult,
    DiscoveredEntities as DiscoveredEntities,
)
from critic.analyzer import analyze_document as analyze_document
from critic.cache import AnalysisCache as AnalysisCache
from critic.critic import (
    run_critic as run_critic,
    insights_to_issues as insights_to_issues,
    CriticInsight as CriticInsight,
    CriticIssue as CriticIssue,
)

__version__ = "0.1.0"
