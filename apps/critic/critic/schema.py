"""
Output schema for analysis results.

Simplified schema for the prose summary approach.
"""

import re
from dataclasses import dataclass, field, asdict
import json


def _camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def _convert_keys(data: dict) -> dict:
    """Recursively convert camelCase keys to snake_case."""
    if not isinstance(data, dict):
        return data
    return {
        _camel_to_snake(k): _convert_keys(v) if isinstance(v, dict) else
        [_convert_keys(i) if isinstance(i, dict) else i for i in v] if isinstance(v, list) else v
        for k, v in data.items()
    }


@dataclass
class DocumentInfo:
    """Information about the analyzed document."""
    title: str
    word_count: int
    chapter_count: int


@dataclass
class ChapterInfo:
    """Information about a chapter."""
    id: str
    title: str
    word_count: int
    summary: str


@dataclass
class Evidence:
    """Evidence for an issue."""
    chapter_id: str = ""
    quote: str = ""
    note: str = ""


@dataclass
class Issue:
    """An issue found in the manuscript."""
    id: str
    type: str
    severity: str  # error, warning, suggestion
    title: str
    description: str
    evidence: list[Evidence] = field(default_factory=list)


@dataclass
class Strength:
    """A strength identified in the manuscript."""
    title: str
    description: str
    examples: list[dict] = field(default_factory=list)


@dataclass
class TokenUsage:
    """Token usage for the analysis."""
    summarization_input: int = 0
    summarization_output: int = 0
    critic_input: int = 0
    critic_output: int = 0

    @property
    def total_input(self) -> int:
        return self.summarization_input + self.critic_input

    @property
    def total_output(self) -> int:
        return self.summarization_output + self.critic_output


@dataclass
class AnalysisSummary:
    """Summary statistics."""
    chapter_count: int
    issue_count: int
    error_count: int
    warning_count: int
    suggestion_count: int
    strength_count: int
    character_count: int = 0
    location_count: int = 0
    timeline_event_count: int = 0


# Wiki types for structured entity data

@dataclass
class CharacterRelationship:
    """A relationship between two characters."""
    target: str
    relationship: str
    description: str = ""


@dataclass
class CharacterAppearance:
    """A character's appearance in a chapter."""
    chapter_id: str
    chapter_title: str
    role: str  # major, minor, mentioned
    summary: str = ""


@dataclass
class WikiCharacter:
    """A wiki entry for a character."""
    name: str
    aliases: list[str] = field(default_factory=list)
    description: str = ""
    physical: str = ""
    personality: str = ""
    background: str = ""
    relationships: list[CharacterRelationship] = field(default_factory=list)
    appearances: list[CharacterAppearance] = field(default_factory=list)
    arc: str = ""


@dataclass
class WikiLocation:
    """A wiki entry for a location."""
    name: str
    description: str = ""
    significance: str = ""
    scenes: list[str] = field(default_factory=list)
    associated_characters: list[str] = field(default_factory=list)


@dataclass
class WikiEvent:
    """An event on the timeline."""
    description: str
    when: str
    where: str = ""
    characters: list[str] = field(default_factory=list)
    chapter_id: str = ""
    is_flashback: bool = False
    sequence: int = 0


@dataclass
class Wiki:
    """Wiki data extracted from the manuscript."""
    characters: list[WikiCharacter] = field(default_factory=list)
    locations: list[WikiLocation] = field(default_factory=list)
    timeline: list[WikiEvent] = field(default_factory=list)


@dataclass
class AnalysisOutput:
    """Complete analysis output."""
    schema_version: str
    analyzed_at: str
    document: DocumentInfo
    chapters: list[ChapterInfo]
    issues: list[Issue]
    strengths: list[Strength]
    summary: AnalysisSummary
    token_usage: TokenUsage
    wiki: Wiki = field(default_factory=Wiki)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict) -> "AnalysisOutput":
        """Create from dictionary."""
        # Parse wiki data
        wiki_data = data.get("wiki", {})
        wiki = Wiki(
            characters=[
                WikiCharacter(
                    name=c.get("name", ""),
                    aliases=c.get("aliases", []),
                    description=c.get("description", ""),
                    physical=c.get("physical", ""),
                    personality=c.get("personality", ""),
                    background=c.get("background", ""),
                    relationships=[
                        CharacterRelationship(**r)
                        for r in c.get("relationships", [])
                    ],
                    appearances=[
                        CharacterAppearance(**a)
                        for a in c.get("appearances", [])
                    ],
                    arc=c.get("arc", ""),
                )
                for c in wiki_data.get("characters", [])
            ],
            locations=[
                WikiLocation(
                    name=loc.get("name", ""),
                    description=loc.get("description", ""),
                    significance=loc.get("significance", ""),
                    scenes=loc.get("scenes", []),
                    associated_characters=loc.get("associated_characters", []),
                )
                for loc in wiki_data.get("locations", [])
            ],
            timeline=[
                WikiEvent(
                    description=e.get("description", ""),
                    when=e.get("when", ""),
                    where=e.get("where", ""),
                    characters=e.get("characters", []),
                    chapter_id=e.get("chapter_id", ""),
                    is_flashback=e.get("is_flashback", False),
                    sequence=e.get("sequence", 0),
                )
                for e in wiki_data.get("timeline", [])
            ],
        )

        return cls(
            schema_version=data.get("schema_version", "2.0"),
            analyzed_at=data.get("analyzed_at", ""),
            document=DocumentInfo(**data.get("document", {})),
            chapters=[ChapterInfo(**c) for c in data.get("chapters", [])],
            issues=[
                Issue(
                    id=i.get("id", ""),
                    type=i.get("type", ""),
                    severity=i.get("severity", ""),
                    title=i.get("title", ""),
                    description=i.get("description", ""),
                    evidence=[Evidence(**e) for e in i.get("evidence", [])],
                )
                for i in data.get("issues", [])
            ],
            strengths=[Strength(**s) for s in data.get("strengths", [])],
            summary=AnalysisSummary(**data.get("summary", {})),
            token_usage=TokenUsage(**data.get("token_usage", {})),
            wiki=wiki,
        )
