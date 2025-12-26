"""
Output schema for analysis results.

Simplified schema for the prose summary approach.
"""

from dataclasses import dataclass, field, asdict
import json


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

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        """Serialize to JSON."""
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, data: dict) -> "AnalysisOutput":
        """Create from dictionary."""
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
        )
