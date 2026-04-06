"""
Analyzer - main orchestration for manuscript analysis.

New simplified flow:
1. Parse document
2. Chunk by chapters
3. Generate prose summaries per chapter
4. Run critic agent (summaries in context, chapter text retrieval)
5. Produce output
"""

from datetime import datetime
from pathlib import Path
from typing import Callable, Optional, Union

from critic.schema import (
    AnalysisOutput,
    DocumentInfo,
    ChapterInfo,
    Issue,
    Strength,
    Evidence,
    AnalysisSummary,
    TokenUsage,
    Wiki,
    WikiCharacter,
    WikiLocation,
    WikiEvent,
    CharacterRelationship,
    CharacterAppearance,
)
from critic.parser import parse_document
from critic.chunker import chunk_document
from critic.summarizer import summarize_chapters
from critic.critic import run_critic
from critic.wiki_extractor import extract_wiki
from critic.config import DEFAULT_MODEL


def analyze_document(
    input_path: Union[str, Path],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    run_critic_phase: bool = True,
    on_progress: Optional[Callable[[str, int, int], None]] = None,
) -> AnalysisOutput:
    """
    Analyze a manuscript and produce structured output.

    Args:
        input_path: Path to .docx, .txt, or .md file
        api_key: Anthropic API key (uses env var if not provided)
        model: Model to use for analysis
        run_critic_phase: Whether to run the critic phase (can skip for just summaries)
        on_progress: Callback (phase, completed, total)

    Returns:
        AnalysisOutput with analysis results
    """
    # Phase 1: Parse document
    if on_progress:
        on_progress('parsing', 0, 1)
    doc = parse_document(file_path=input_path)
    if on_progress:
        on_progress('parsing', 1, 1)

    print(f"[Analyzer] Parsed: {doc.title} ({doc.word_count:,} words)")

    # Phase 2: Chunk by chapters
    if on_progress:
        on_progress('chunking', 0, 1)
    chapters = chunk_document(doc)
    if on_progress:
        on_progress('chunking', 1, 1)

    print(f"[Analyzer] Split into {len(chapters)} chapters")

    # Phase 3: Generate summaries
    summaries = summarize_chapters(
        chapters,
        api_key=api_key,
        model=model,
        on_progress=lambda c, t: on_progress('summarizing', c, t) if on_progress else None,
    )

    # Calculate summarization token usage (approximate from summary length)
    summary_input_tokens = sum(len(c.content) // 4 for c in chapters)
    summary_output_tokens = sum(s.word_count * 4 // 3 for s in summaries)

    # Phase 4: Generate wiki from summaries
    if on_progress:
        on_progress('wiki', 0, 1)
    wiki_result = extract_wiki(summaries, api_key=api_key, model=model)
    if on_progress:
        on_progress('wiki', 1, 1)

    # Convert wiki.py types to schema.py types
    wiki = Wiki(
        characters=[
            WikiCharacter(
                name=c.name,
                aliases=c.aliases,
                description=c.description,
                physical=c.physical,
                personality=c.personality,
                background=c.background,
                relationships=[
                    CharacterRelationship(
                        target=r.target,
                        relationship=r.relationship,
                        description=r.description,
                    )
                    for r in c.relationships
                ],
                appearances=[
                    CharacterAppearance(
                        chapter_id=a.chapter_id,
                        chapter_title=a.chapter_title,
                        role=a.role,
                        summary=a.summary,
                    )
                    for a in c.appearances
                ],
                arc=c.arc,
            )
            for c in wiki_result.characters
        ],
        locations=[
            WikiLocation(
                name=loc.name,
                description=loc.description,
                significance=loc.significance,
                scenes=loc.scenes,
                associated_characters=loc.associated_characters,
            )
            for loc in wiki_result.locations
        ],
        timeline=[
            WikiEvent(
                description=e.description,
                when=e.when,
                where=e.where or "",
                characters=e.characters,
                chapter_id=e.chapter_id,
                is_flashback=e.is_flashback,
                sequence=e.sequence,
            )
            for e in wiki_result.timeline
        ],
    )

    # Phase 5: Run critic
    issues: list[Issue] = []
    strengths: list[Strength] = []
    critic_input_tokens = 0
    critic_output_tokens = 0

    if run_critic_phase:
        critic_result = run_critic(
            chapters,
            summaries,
            api_key=api_key,
            model=model,
            on_progress=lambda i, m, a: on_progress('analyzing', i, m) if on_progress else None,
        )

        # Convert critic issues to schema
        for ci in critic_result.issues:
            evidence_list = []
            for e in ci.evidence:
                if isinstance(e, dict):
                    evidence_list.append(Evidence(
                        chapter_id=e.get('chapter_id', ''),
                        quote=e.get('quote', ''),
                        note=e.get('note', ''),
                    ))
                elif isinstance(e, str):
                    evidence_list.append(Evidence(
                        chapter_id='',
                        quote=e,
                        note='',
                    ))
            issues.append(Issue(
                id=ci.id,
                type=ci.type,
                severity=ci.severity,
                title=ci.title,
                description=ci.description,
                evidence=evidence_list,
            ))

        # Convert critic strengths to schema
        for cs in critic_result.strengths:
            strengths.append(Strength(
                title=cs.title,
                description=cs.description,
                examples=cs.examples,
            ))

        critic_input_tokens = critic_result.token_usage['input_tokens']
        critic_output_tokens = critic_result.token_usage['output_tokens']

    # Build chapter info
    chapter_infos = [
        ChapterInfo(
            id=c.id,
            title=c.title or c.id,
            word_count=len(c.content.split()),
            summary=s.summary,
        )
        for c, s in zip(chapters, summaries)
    ]

    # Build summary
    error_count = len([i for i in issues if i.severity == 'error'])
    warning_count = len([i for i in issues if i.severity == 'warning'])
    suggestion_count = len([i for i in issues if i.severity == 'suggestion'])

    summary = AnalysisSummary(
        chapter_count=len(chapters),
        issue_count=len(issues),
        error_count=error_count,
        warning_count=warning_count,
        suggestion_count=suggestion_count,
        strength_count=len(strengths),
        character_count=len(wiki.characters),
        location_count=len(wiki.locations),
        timeline_event_count=len(wiki.timeline),
    )

    # Build document info
    document_info = DocumentInfo(
        title=doc.title,
        word_count=doc.word_count,
        chapter_count=len(chapters),
    )

    # Build token usage
    token_usage = TokenUsage(
        summarization_input=summary_input_tokens,
        summarization_output=summary_output_tokens,
        critic_input=critic_input_tokens,
        critic_output=critic_output_tokens,
    )

    print(f"[Analyzer] Complete: {len(issues)} issues, {len(strengths)} strengths")
    print(f"[Analyzer] Wiki: {len(wiki.characters)} characters, {len(wiki.locations)} locations, "
          f"{len(wiki.timeline)} events")
    print(f"[Analyzer] Tokens: ~{token_usage.total_input + token_usage.total_output:,} total")

    return AnalysisOutput(
        schema_version="2.0",
        analyzed_at=datetime.now().isoformat(),
        document=document_info,
        chapters=chapter_infos,
        issues=issues,
        strengths=strengths,
        summary=summary,
        token_usage=token_usage,
        wiki=wiki,
    )
