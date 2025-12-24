"""
Output schema for analysis results.

These types match the TypeScript schema and are used for JSON serialization
to communicate with the frontend.
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field


class TextLocation(BaseModel):
    """Location of text within a chunk."""
    chunk_id: str
    start_offset: int
    end_offset: int
    snippet: str
    human_readable: str


class EventExtraction(BaseModel):
    """An event extracted from the text."""
    id: str
    description: str
    time_marker: str
    precision: Literal["exact", "relative", "vague"]
    sequence_note: Optional[str] = None
    character_ids: list[str] = Field(default_factory=list)
    location: TextLocation


class CharacterMention(BaseModel):
    """A mention of a character in the text."""
    character_id: str = ""
    name: str
    role: Literal["present", "mentioned", "flashback"]
    location: TextLocation
    attributes_mentioned: list[str] = Field(default_factory=list)
    relationships_mentioned: list[dict] = Field(default_factory=list)


class FactExtraction(BaseModel):
    """A fact extracted from the text."""
    id: str
    content: str
    category: Literal["character", "world", "location", "object", "relationship", "other"]
    subject: str
    entity_id: Optional[str] = None
    location: TextLocation
    contradicts: Optional[dict] = None


class PlotThreadTouch(BaseModel):
    """A touch/interaction with a plot thread."""
    thread_id: str = ""
    name: str = ""
    action: Literal["introduced", "advanced", "complicated", "resolved"]
    description: str
    location: TextLocation


class SetupExtraction(BaseModel):
    """A setup/foreshadowing extracted from the text."""
    id: str
    description: str
    weight: Literal["subtle", "moderate", "heavy"]
    implied_payoff: str
    location: TextLocation
    payoff: Optional[dict] = None
    status: Literal["pending", "resolved", "orphaned"] = "pending"
    issue_id: Optional[str] = None


class ChunkExtraction(BaseModel):
    """All extractions from a single chunk."""
    events: list[EventExtraction] = Field(default_factory=list)
    character_mentions: list[CharacterMention] = Field(default_factory=list)
    facts: list[FactExtraction] = Field(default_factory=list)
    plot_threads: list[PlotThreadTouch] = Field(default_factory=list)
    setups: list[SetupExtraction] = Field(default_factory=list)
    open_questions: list[str] = Field(default_factory=list)


class ChunkWithText(BaseModel):
    """A chunk with its full text and extraction results."""
    id: str
    title: Optional[str]
    text: str
    start_offset: int
    end_offset: int
    extraction: ChunkExtraction


class CharacterAttribute(BaseModel):
    """An attribute of a character."""
    attribute: str
    value: str
    location: TextLocation
    conflicts_with: Optional[dict] = None


class CharacterAppearance(BaseModel):
    """An appearance of a character in a chunk."""
    chunk_id: str
    role: Literal["present", "mentioned", "flashback"]
    mentions: list[TextLocation] = Field(default_factory=list)


class CharacterRelationship(BaseModel):
    """A relationship between characters."""
    target_character_id: str
    target_name: str
    relationship: str
    shared_event_ids: list[str] = Field(default_factory=list)


class CharacterStats(BaseModel):
    """Statistics about a character."""
    first_appearance: str
    last_appearance: str
    total_mentions: int
    present_in_chunks: int


class CharacterEntity(BaseModel):
    """A character entity aggregated from all mentions."""
    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    attributes: list[CharacterAttribute] = Field(default_factory=list)
    appearances: list[CharacterAppearance] = Field(default_factory=list)
    relationships: list[CharacterRelationship] = Field(default_factory=list)
    event_ids: list[str] = Field(default_factory=list)
    issue_ids: list[str] = Field(default_factory=list)
    stats: CharacterStats


class LocationEntity(BaseModel):
    """A location entity."""
    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    description: Optional[str] = None
    appearances: list[dict] = Field(default_factory=list)
    parent_location_id: Optional[str] = None


class ObjectEntity(BaseModel):
    """An object entity."""
    id: str
    name: str
    description: Optional[str] = None
    significance: Literal["normal", "emphasized", "chekhov"] = "normal"
    appearances: list[dict] = Field(default_factory=list)
    payoff_status: Optional[Literal["pending", "resolved", "abandoned"]] = None
    issue_ids: list[str] = Field(default_factory=list)


class EntityIndex(BaseModel):
    """Index of all entities in the document."""
    characters: list[CharacterEntity] = Field(default_factory=list)
    locations: list[LocationEntity] = Field(default_factory=list)
    objects: list[ObjectEntity] = Field(default_factory=list)


class PlotThreadEvent(BaseModel):
    """An event in a plot thread's lifecycle."""
    chunk_id: str
    action: Literal["introduced", "advanced", "complicated", "resolved"]
    description: str
    location: TextLocation


class PlotThreadView(BaseModel):
    """A plot thread with its full lifecycle."""
    id: str
    name: str
    description: str
    status: Literal["active", "resolved", "abandoned"]
    lifecycle: list[PlotThreadEvent] = Field(default_factory=list)
    issue_ids: list[str] = Field(default_factory=list)


class TimelineEvent(BaseModel):
    """An event positioned on the timeline."""
    event_id: str
    position: float
    confidence: float


class TimelineInconsistency(BaseModel):
    """A detected timeline inconsistency."""
    description: str
    event_ids: list[str]
    issue_id: str = ""


class TimeSpan(BaseModel):
    """A span of time in the narrative."""
    id: str
    name: str
    start_position: float
    end_position: float
    description: Optional[str] = None


class TimelineView(BaseModel):
    """The reconstructed timeline."""
    events: list[TimelineEvent] = Field(default_factory=list)
    inconsistencies: list[TimelineInconsistency] = Field(default_factory=list)
    spans: list[TimeSpan] = Field(default_factory=list)


class EvidenceItem(BaseModel):
    """Evidence for an issue."""
    quote: str
    location: Optional[TextLocation] = None
    note: Optional[str] = None


IssueType = Literal[
    "timeline_inconsistency",
    "character_inconsistency",
    "fact_contradiction",
    "unresolved_thread",
    "orphaned_payoff",
    "missing_setup",
    "over_foreshadowed",
    "under_foreshadowed",
    "dropped_character",
    "dropped_object",
    "continuity_error",
]


class IssueWithContext(BaseModel):
    """An issue with full context."""
    id: str
    type: IssueType
    severity: Literal["error", "warning", "info"]
    title: str
    description: str
    chunk_ids: list[str] = Field(default_factory=list)
    evidence: list[EvidenceItem] = Field(default_factory=list)
    related_entity_ids: list[str] = Field(default_factory=list)
    status: Literal["open", "dismissed", "fixed"] = "open"
    user_note: Optional[str] = None


class TokenUsagePhase(BaseModel):
    """Token usage for a single phase."""
    input_tokens: int
    output_tokens: int


class TokenUsage(BaseModel):
    """Token usage across all phases."""
    discovery: TokenUsagePhase
    extraction: TokenUsagePhase
    total: TokenUsagePhase


class IssuesBySeverity(BaseModel):
    """Issue counts by severity."""
    error: int = 0
    warning: int = 0
    info: int = 0


class AnalysisSummary(BaseModel):
    """Summary statistics for the analysis."""
    total_chunks: int
    character_count: int
    location_count: int
    object_count: int
    event_count: int
    plot_thread_count: int
    unresolved_thread_count: int
    setup_count: int
    unresolved_setup_count: int
    issue_count: int
    issues_by_type: dict[str, int] = Field(default_factory=dict)
    issues_by_severity: IssuesBySeverity = Field(default_factory=IssuesBySeverity)
    token_usage: Optional[TokenUsage] = None


class DocumentInfo(BaseModel):
    """Information about the analyzed document."""
    title: str
    word_count: int
    char_count: int
    chapter_count: int
    source: Optional[dict] = None


class AnalysisOutput(BaseModel):
    """Complete analysis output."""
    schema_version: str = "1.0"
    analyzed_at: str
    document: DocumentInfo
    chunks: list[ChunkWithText]
    entities: EntityIndex
    timeline: TimelineView
    plot_threads: list[PlotThreadView]
    issues: list[IssueWithContext]
    summary: AnalysisSummary

    class Config:
        # Use camelCase for JSON serialization to match TypeScript frontend
        populate_by_name = True

    def model_dump_json_for_frontend(self) -> str:
        """Serialize to JSON with camelCase keys for the frontend."""
        import json

        def to_camel_case(snake_str: str) -> str:
            components = snake_str.split('_')
            return components[0] + ''.join(x.title() for x in components[1:])

        def convert_keys(obj):
            if isinstance(obj, dict):
                return {to_camel_case(k): convert_keys(v) for k, v in obj.items()}
            elif isinstance(obj, list):
                return [convert_keys(item) for item in obj]
            else:
                return obj

        data = self.model_dump()
        camel_data = convert_keys(data)
        return json.dumps(camel_data, indent=2)
