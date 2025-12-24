"""
Analyzer - main orchestration for manuscript analysis.

Coordinates:
1. Parsing
2. Chunking
3. Discovery pass
4. Extraction pass
5. Aggregation
6. Timeline reconstruction
7. Issue detection
"""

from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Union

from .schema import (
    AnalysisOutput,
    DocumentInfo,
    ChunkWithText,
    IssueWithContext,
    EvidenceItem,
    AnalysisSummary,
    TokenUsage,
    TokenUsagePhase,
    IssuesBySeverity,
    CharacterEntity,
    PlotThreadView,
    TimelineView,
)
from .parser import parse_document
from .chunker import chunk_document
from .discovery import discover_entities
from .extractor import extract_from_chunks
from .aggregator import aggregate_entities
from .timeline import reconstruct_timeline
from .cache import AnalysisCache


DEFAULT_MODEL = "claude-sonnet-4-20250514"


def analyze_document(
    input_path: Union[str, Path],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    cache: bool = True,
    cache_dir: Optional[str] = None,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
) -> AnalysisOutput:
    """
    Analyze a manuscript and produce structured output.

    Args:
        input_path: Path to .docx, .txt, or .md file
        api_key: Anthropic API key (uses env var if not provided)
        model: Model to use for analysis
        cache: Whether to enable caching
        cache_dir: Custom cache directory
        on_progress: Callback (phase, completed, total)

    Returns:
        AnalysisOutput with all analysis results
    """
    # Initialize cache
    analysis_cache = AnalysisCache(cache_dir=cache_dir, enabled=cache) if cache else None

    if analysis_cache:
        stats = analysis_cache.get_stats()
        print(f"[Cache] Using cache: {stats.chunks} chunks, "
              f"{stats.discovery} discoveries, {stats.extraction} extractions "
              f"({stats.total_size})")

    # Phase 1: Parse document
    if on_progress:
        on_progress('parsing', 0, 1)
    doc = parse_document(file_path=input_path)
    if on_progress:
        on_progress('parsing', 1, 1)

    # Phase 2: Chunk document
    if on_progress:
        on_progress('chunking', 0, 1)

    chunks = None
    if analysis_cache:
        chunks = analysis_cache.get_chunks(doc.full_text)

    if not chunks:
        chunks = chunk_document(doc)
        if analysis_cache:
            analysis_cache.set_chunks(doc.full_text, chunks)

    if on_progress:
        on_progress('chunking', 1, 1)

    # Phase 3: Discovery pass
    discovery_result = None
    if analysis_cache:
        discovery_result = analysis_cache.get_discovery(doc.full_text, model)

    if discovery_result:
        print("[Cache] Using cached discovery results")
        if on_progress:
            on_progress('discovering', 1, 1)
    else:
        discovery_result = discover_entities(
            chunks,
            api_key=api_key,
            model=model,
            on_progress=lambda c, t: on_progress('discovering', c, t) if on_progress else None,
        )
        if analysis_cache:
            analysis_cache.set_discovery(doc.full_text, model, discovery_result)

    # Phase 4: Extraction pass
    extracted_chunks, extraction_usage = extract_from_chunks(
        chunks,
        api_key=api_key,
        model=model,
        discovered_entities=discovery_result.entities,
        cache=analysis_cache,
        on_progress=lambda c, t, cid: on_progress('extracting', c, t) if on_progress else None,
    )

    # Phase 5: Aggregate entities
    if on_progress:
        on_progress('aggregating', 0, 1)
    chunks_with_text, entities, plot_threads = aggregate_entities(extracted_chunks)
    if on_progress:
        on_progress('aggregating', 1, 1)

    # Phase 6: Reconstruct timeline
    if on_progress:
        on_progress('timeline', 0, 1)
    timeline = reconstruct_timeline(chunks_with_text)
    if on_progress:
        on_progress('timeline', 1, 1)

    # Phase 7: Detect issues
    if on_progress:
        on_progress('detecting', 0, 1)
    issues = _detect_issues(chunks_with_text, entities.characters, plot_threads, timeline)
    _link_issues_to_entities(issues, entities.characters, plot_threads)
    if on_progress:
        on_progress('detecting', 1, 1)

    # Build token usage summary
    token_usage = TokenUsage(
        discovery=TokenUsagePhase(
            input_tokens=discovery_result.token_usage['input_tokens'],
            output_tokens=discovery_result.token_usage['output_tokens'],
        ),
        extraction=TokenUsagePhase(
            input_tokens=extraction_usage['input_tokens'],
            output_tokens=extraction_usage['output_tokens'],
        ),
        total=TokenUsagePhase(
            input_tokens=(
                discovery_result.token_usage['input_tokens'] +
                extraction_usage['input_tokens']
            ),
            output_tokens=(
                discovery_result.token_usage['output_tokens'] +
                extraction_usage['output_tokens']
            ),
        ),
    )

    # Build summary
    summary = _build_summary(chunks_with_text, entities, plot_threads, issues, token_usage)

    # Build document info
    document_info = DocumentInfo(
        title=doc.title,
        word_count=doc.word_count,
        char_count=len(doc.full_text),
        chapter_count=len([h for h in doc.headings if h.level <= 2]),
    )

    return AnalysisOutput(
        schema_version="1.0",
        analyzed_at=datetime.now().isoformat(),
        document=document_info,
        chunks=chunks_with_text,
        entities=entities,
        timeline=timeline,
        plot_threads=plot_threads,
        issues=issues,
        summary=summary,
    )


def _detect_issues(
    chunks: list[ChunkWithText],
    characters: list[CharacterEntity],
    plot_threads: list[PlotThreadView],
    timeline: TimelineView,
) -> list[IssueWithContext]:
    """Detect issues using heuristics."""
    issues: list[IssueWithContext] = []
    issue_counter = 0

    # 1. Character inconsistencies (attribute conflicts)
    for char in characters:
        attrs_by_type: dict[str, list] = {}

        for attr in char.attributes:
            attr_type = attr.attribute.lower()
            if attr_type not in attrs_by_type:
                attrs_by_type[attr_type] = []
            attrs_by_type[attr_type].append(attr)

        for attr_type, attrs in attrs_by_type.items():
            if len(attrs) >= 2:
                unique_values = set(a.value.lower() for a in attrs)
                if len(unique_values) > 1:
                    issue_counter += 1
                    issue_id = f"issue-{issue_counter}"

                    issues.append(IssueWithContext(
                        id=issue_id,
                        type="character_inconsistency",
                        severity="error",
                        title=f"{char.name}'s {attr_type} inconsistency",
                        description=f"{char.name} is described with conflicting {attr_type}: {' vs '.join(unique_values)}",
                        chunk_ids=[a.location.chunk_id for a in attrs],
                        evidence=[
                            EvidenceItem(
                                quote=a.location.snippet,
                                location=a.location,
                                note=f"{attr_type}: {a.value}",
                            )
                            for a in attrs
                        ],
                        related_entity_ids=[char.id],
                    ))

                    # Mark attributes as conflicting
                    for i, attr in enumerate(attrs[1:], 1):
                        attr.conflicts_with = {'attributeIndex': 0, 'issueId': issue_id}

                    char.issue_ids.append(issue_id)

    # 2. Unresolved plot threads
    for thread in plot_threads:
        if thread.status == 'abandoned':
            issue_counter += 1
            issue_id = f"issue-{issue_counter}"

            issues.append(IssueWithContext(
                id=issue_id,
                type="unresolved_thread",
                severity="warning",
                title=f"Unresolved: {thread.name}",
                description=f'Plot thread "{thread.name}" was introduced but never resolved',
                chunk_ids=[e.chunk_id for e in thread.lifecycle],
                evidence=[
                    EvidenceItem(
                        quote=e.location.snippet,
                        location=e.location,
                        note=e.action,
                    )
                    for e in thread.lifecycle
                ],
            ))

            thread.issue_ids.append(issue_id)

    # 3. Dropped characters
    for char in characters:
        if (char.stats.total_mentions == 1 and
            len(char.appearances) == 1 and
            char.appearances[0].role == 'present'):

            # Check if in first half
            chunk_ids = [c.id for c in chunks]
            try:
                chunk_idx = chunk_ids.index(char.appearances[0].chunk_id)
                if chunk_idx < len(chunks) / 2:
                    issue_counter += 1
                    issue_id = f"issue-{issue_counter}"

                    issues.append(IssueWithContext(
                        id=issue_id,
                        type="dropped_character",
                        severity="info",
                        title=f"Dropped character: {char.name}",
                        description=f"{char.name} appears once and is never seen again",
                        chunk_ids=[char.appearances[0].chunk_id],
                        evidence=[
                            EvidenceItem(
                                quote=char.appearances[0].mentions[0].snippet if char.appearances[0].mentions else "",
                                location=char.appearances[0].mentions[0] if char.appearances[0].mentions else None,
                                note="Only appearance",
                            )
                        ] if char.appearances[0].mentions else [],
                        related_entity_ids=[char.id],
                    ))

                    char.issue_ids.append(issue_id)
            except ValueError:
                pass

    # 4. Timeline inconsistencies
    for inconsistency in timeline.inconsistencies:
        issue_counter += 1
        issue_id = f"issue-{issue_counter}"
        inconsistency.issue_id = issue_id

        issues.append(IssueWithContext(
            id=issue_id,
            type="timeline_inconsistency",
            severity="error",
            title="Timeline conflict",
            description=inconsistency.description,
            chunk_ids=[],
            evidence=[],
        ))

    # 5. Orphaned setups
    for chunk in chunks:
        for setup in chunk.extraction.setups:
            if setup.status == 'pending' and setup.weight != 'subtle':
                issue_counter += 1
                issue_id = f"issue-{issue_counter}"
                setup.issue_id = issue_id

                issues.append(IssueWithContext(
                    id=issue_id,
                    type="orphaned_payoff",
                    severity="warning" if setup.weight == 'heavy' else "info",
                    title=f"Unresolved setup: {setup.description}",
                    description=f'Setup "{setup.description}" implies payoff "{setup.implied_payoff}" but no resolution was detected',
                    chunk_ids=[chunk.id],
                    evidence=[
                        EvidenceItem(
                            quote=setup.location.snippet,
                            location=setup.location,
                            note=f"{setup.weight} foreshadowing",
                        )
                    ],
                ))

    return issues


def _link_issues_to_entities(
    issues: list[IssueWithContext],
    characters: list[CharacterEntity],
    plot_threads: list[PlotThreadView],
) -> None:
    """Link issues back to entities (already done during detection)."""
    pass


def _build_summary(
    chunks: list[ChunkWithText],
    entities,
    plot_threads: list[PlotThreadView],
    issues: list[IssueWithContext],
    token_usage: TokenUsage,
) -> AnalysisSummary:
    """Build summary statistics."""
    issues_by_type: dict[str, int] = {
        'timeline_inconsistency': 0,
        'character_inconsistency': 0,
        'fact_contradiction': 0,
        'unresolved_thread': 0,
        'orphaned_payoff': 0,
        'missing_setup': 0,
        'over_foreshadowed': 0,
        'under_foreshadowed': 0,
        'dropped_character': 0,
        'dropped_object': 0,
        'continuity_error': 0,
    }

    issues_by_severity = IssuesBySeverity()

    for issue in issues:
        if issue.type in issues_by_type:
            issues_by_type[issue.type] += 1
        if issue.severity == 'error':
            issues_by_severity.error += 1
        elif issue.severity == 'warning':
            issues_by_severity.warning += 1
        else:
            issues_by_severity.info += 1

    event_count = sum(len(c.extraction.events) for c in chunks)
    setup_count = sum(len(c.extraction.setups) for c in chunks)
    unresolved_setup_count = sum(
        len([s for s in c.extraction.setups if s.status == 'pending'])
        for c in chunks
    )

    return AnalysisSummary(
        total_chunks=len(chunks),
        character_count=len(entities.characters),
        location_count=len(entities.locations),
        object_count=len(entities.objects),
        event_count=event_count,
        plot_thread_count=len(plot_threads),
        unresolved_thread_count=len([t for t in plot_threads if t.status == 'abandoned']),
        setup_count=setup_count,
        unresolved_setup_count=unresolved_setup_count,
        issue_count=len(issues),
        issues_by_type=issues_by_type,
        issues_by_severity=issues_by_severity,
        token_usage=token_usage,
    )
