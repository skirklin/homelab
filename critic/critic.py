"""
Literary Critic Agent - agentic analysis using tool calls.

Reasons over extracted data to find higher-level issues
and provide insights about the manuscript.
"""

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import anthropic
from anthropic.types import MessageParam, ToolParam, TextBlock

from .schema import AnalysisOutput, EventExtraction, ChunkWithText


# Tool definitions for the Claude API
CRITIC_TOOLS: list[ToolParam] = [
    {
        "name": "search_characters",
        "description": "Search for characters by name or attribute.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
                "limit": {"type": "integer", "description": "Max results (default: 10)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "get_character_details",
        "description": "Get detailed info about a specific character.",
        "input_schema": {
            "type": "object",
            "properties": {
                "character_id": {"type": "string"},
            },
            "required": ["character_id"],
        },
    },
    {
        "name": "search_events",
        "description": "Search for events by description, time, or characters.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "character_id": {"type": "string"},
                "chunk_id": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "get_event_details",
        "description": "Get detailed info about a specific event.",
        "input_schema": {
            "type": "object",
            "properties": {
                "event_id": {"type": "string"},
                "include_context": {"type": "boolean", "default": True},
            },
            "required": ["event_id"],
        },
    },
    {
        "name": "search_facts",
        "description": "Search for established facts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "category": {"type": "string"},
                "subject": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
    },
    {
        "name": "get_plot_threads",
        "description": "Get all plot threads.",
        "input_schema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["active", "resolved", "abandoned"]},
            },
        },
    },
    {
        "name": "get_plot_thread_details",
        "description": "Get detailed info about a plot thread.",
        "input_schema": {
            "type": "object",
            "properties": {
                "thread_id": {"type": "string"},
            },
            "required": ["thread_id"],
        },
    },
    {
        "name": "read_chunk",
        "description": "Read the full text of a chunk.",
        "input_schema": {
            "type": "object",
            "properties": {
                "chunk_id": {"type": "string"},
            },
            "required": ["chunk_id"],
        },
    },
    {
        "name": "read_text_at_location",
        "description": "Read text around a specific location.",
        "input_schema": {
            "type": "object",
            "properties": {
                "chunk_id": {"type": "string"},
                "start_offset": {"type": "integer"},
                "end_offset": {"type": "integer"},
                "context_chars": {"type": "integer", "default": 200},
            },
            "required": ["chunk_id", "start_offset", "end_offset"],
        },
    },
    {
        "name": "get_existing_issues",
        "description": "Get issues detected by systematic analysis.",
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {"type": "string"},
                "severity": {"type": "string", "enum": ["error", "warning", "info"]},
                "character_id": {"type": "string"},
            },
        },
    },
    {
        "name": "get_document_overview",
        "description": "Get high-level document overview.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "compare_character_timelines",
        "description": "Compare timelines of two characters.",
        "input_schema": {
            "type": "object",
            "properties": {
                "character_id_1": {"type": "string"},
                "character_id_2": {"type": "string"},
            },
            "required": ["character_id_1", "character_id_2"],
        },
    },
    {
        "name": "report_insight",
        "description": "Report an insight or finding.",
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": [
                        "continuity_issue", "character_arc_observation", "plot_hole",
                        "pacing_concern", "thematic_insight", "structural_observation",
                        "strength", "suggestion",
                    ],
                },
                "severity": {
                    "type": "string",
                    "enum": ["critical", "important", "minor", "observation"],
                },
                "title": {"type": "string"},
                "description": {"type": "string"},
                "evidence": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "chunk_id": {"type": "string"},
                            "quote": {"type": "string"},
                            "note": {"type": "string"},
                        },
                    },
                },
                "related_entity_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["type", "severity", "title", "description"],
        },
    },
]


@dataclass
class CriticInsight:
    """An insight reported by the critic."""
    type: str
    severity: str
    title: str
    description: str
    evidence: list[dict] = field(default_factory=list)
    related_entity_ids: list[str] = field(default_factory=list)


@dataclass
class CriticIssue:
    """A critic insight converted to issue format."""
    id: str
    type: str
    severity: str
    title: str
    description: str
    chunk_ids: list[str]
    evidence: list[dict]
    related_entity_ids: list[str]
    status: str = "open"
    source: str = "critic"


@dataclass
class CriticProgress:
    """Progress update from the critic."""
    phase: str
    iteration: int
    max_iterations: int
    current_activity: Optional[str] = None
    insights_found: int = 0


@dataclass
class CriticResult:
    """Result of running the critic."""
    insights: list[CriticInsight]
    token_usage: dict
    iterations: int


class CriticToolExecutor:
    """Executes tools against analysis data."""

    def __init__(self, analysis: AnalysisOutput):
        self.analysis = analysis
        self.insights: list[CriticInsight] = []

        # Build lookup maps
        self.chunks: dict[str, ChunkWithText] = {c.id: c for c in analysis.chunks}
        self.events: dict[str, tuple[EventExtraction, ChunkWithText]] = {}

        for chunk in analysis.chunks:
            for event in chunk.extraction.events:
                self.events[event.id] = (event, chunk)

    def execute(self, tool_name: str, inputs: dict) -> str:
        """Execute a tool and return JSON result."""
        method = getattr(self, f"_tool_{tool_name}", None)
        if method:
            return json.dumps(method(inputs))
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def get_insights(self) -> list[CriticInsight]:
        return self.insights

    def _tool_search_characters(self, inputs: dict) -> dict:
        query = inputs.get("query", "").lower()
        limit = inputs.get("limit", 10)

        results = []
        for char in self.analysis.entities.characters:
            if (query in char.name.lower() or
                any(query in a.lower() for a in char.aliases) or
                any(query in a.attribute.lower() or query in a.value.lower()
                    for a in char.attributes)):
                results.append({
                    "id": char.id,
                    "name": char.name,
                    "aliases": char.aliases,
                    "total_mentions": char.stats.total_mentions,
                    "issue_count": len(char.issue_ids),
                })
                if len(results) >= limit:
                    break

        return {"characters": results, "total": len(results)}

    def _tool_get_character_details(self, inputs: dict) -> dict:
        char_id = inputs.get("character_id")
        char = next((c for c in self.analysis.entities.characters if c.id == char_id), None)

        if not char:
            return {"error": f"Character not found: {char_id}"}

        events = []
        for eid in char.event_ids:
            if eid in self.events:
                event, chunk = self.events[eid]
                events.append({
                    "id": event.id,
                    "description": event.description,
                    "time_marker": event.time_marker,
                    "chunk_id": chunk.id,
                })

        return {
            "id": char.id,
            "name": char.name,
            "aliases": char.aliases,
            "attributes": [{"attribute": a.attribute, "value": a.value} for a in char.attributes],
            "relationships": [{"target": r.target_name, "relationship": r.relationship} for r in char.relationships],
            "stats": {
                "total_mentions": char.stats.total_mentions,
                "present_in_chunks": char.stats.present_in_chunks,
            },
            "events": events[:20],
            "issue_ids": char.issue_ids,
        }

    def _tool_search_events(self, inputs: dict) -> dict:
        query = inputs.get("query", "").lower()
        char_id = inputs.get("character_id")
        chunk_id = inputs.get("chunk_id")
        limit = inputs.get("limit", 20)

        results = []
        for chunk in self.analysis.chunks:
            if chunk_id and chunk.id != chunk_id:
                continue

            for event in chunk.extraction.events:
                if char_id and char_id not in event.character_ids:
                    continue
                if query and query not in event.description.lower():
                    continue

                results.append({
                    "id": event.id,
                    "description": event.description,
                    "time_marker": event.time_marker,
                    "chunk_id": chunk.id,
                })

                if len(results) >= limit:
                    return {"events": results, "total": len(results)}

        return {"events": results, "total": len(results)}

    def _tool_get_event_details(self, inputs: dict) -> dict:
        event_id = inputs.get("event_id")
        include_context = inputs.get("include_context", True)

        if event_id not in self.events:
            return {"error": f"Event not found: {event_id}"}

        event, chunk = self.events[event_id]

        result = {
            "id": event.id,
            "description": event.description,
            "time_marker": event.time_marker,
            "precision": event.precision,
            "character_ids": event.character_ids,
            "location": {
                "chunk_id": chunk.id,
                "snippet": event.location.snippet,
            },
        }

        if include_context:
            start = max(0, event.location.start_offset - 200)
            end = min(len(chunk.text), event.location.end_offset + 200)
            result["context"] = chunk.text[start:end]

        return result

    def _tool_search_facts(self, inputs: dict) -> dict:
        query = inputs.get("query", "").lower()
        category = inputs.get("category")
        subject = inputs.get("subject", "").lower()
        limit = inputs.get("limit", 20)

        results = []
        for chunk in self.analysis.chunks:
            for fact in chunk.extraction.facts:
                if category and fact.category != category:
                    continue
                if subject and subject not in fact.subject.lower():
                    continue
                if query and query not in fact.content.lower():
                    continue

                results.append({
                    "id": fact.id,
                    "content": fact.content,
                    "category": fact.category,
                    "subject": fact.subject,
                    "chunk_id": chunk.id,
                })

                if len(results) >= limit:
                    return {"facts": results, "total": len(results)}

        return {"facts": results, "total": len(results)}

    def _tool_get_plot_threads(self, inputs: dict) -> dict:
        status = inputs.get("status")

        threads = self.analysis.plot_threads
        if status:
            threads = [t for t in threads if t.status == status]

        return {
            "threads": [
                {
                    "id": t.id,
                    "name": t.name,
                    "description": t.description,
                    "status": t.status,
                    "lifecycle_length": len(t.lifecycle),
                }
                for t in threads
            ],
            "total": len(threads),
        }

    def _tool_get_plot_thread_details(self, inputs: dict) -> dict:
        thread_id = inputs.get("thread_id")
        thread = next((t for t in self.analysis.plot_threads if t.id == thread_id), None)

        if not thread:
            return {"error": f"Thread not found: {thread_id}"}

        return {
            "id": thread.id,
            "name": thread.name,
            "description": thread.description,
            "status": thread.status,
            "lifecycle": [
                {
                    "chunk_id": e.chunk_id,
                    "action": e.action,
                    "description": e.description,
                }
                for e in thread.lifecycle
            ],
        }

    def _tool_read_chunk(self, inputs: dict[str, Any]) -> dict[str, Any]:
        chunk_id = inputs.get("chunk_id")
        if not chunk_id:
            return {"error": "chunk_id is required"}
        chunk = self.chunks.get(chunk_id)

        if not chunk:
            return {"error": f"Chunk not found: {chunk_id}"}

        return {
            "id": chunk.id,
            "title": chunk.title,
            "text": chunk.text,
            "word_count": len(chunk.text.split()),
        }

    def _tool_read_text_at_location(self, inputs: dict[str, Any]) -> dict[str, Any]:
        chunk_id = inputs.get("chunk_id")
        if not chunk_id:
            return {"error": "chunk_id is required"}
        start = inputs.get("start_offset", 0)
        end = inputs.get("end_offset", 0)
        context = inputs.get("context_chars", 200)

        chunk = self.chunks.get(chunk_id)
        if not chunk:
            return {"error": f"Chunk not found: {chunk_id}"}

        actual_start = max(0, start - context)
        actual_end = min(len(chunk.text), end + context)

        return {
            "chunk_id": chunk_id,
            "text": chunk.text[actual_start:actual_end],
        }

    def _tool_get_existing_issues(self, inputs: dict[str, Any]) -> dict[str, Any]:
        issue_type = inputs.get("type")
        severity = inputs.get("severity")
        char_id = inputs.get("character_id")

        issues = self.analysis.issues
        if issue_type:
            issues = [i for i in issues if i.type == issue_type]
        if severity:
            issues = [i for i in issues if i.severity == severity]
        if char_id:
            issues = [i for i in issues if char_id in i.related_entity_ids]

        return {
            "issues": [
                {
                    "id": i.id,
                    "type": i.type,
                    "severity": i.severity,
                    "title": i.title,
                    "description": i.description,
                }
                for i in issues
            ],
            "total": len(issues),
        }

    def _tool_get_document_overview(self, _inputs: dict[str, Any]) -> dict[str, Any]:
        summary = self.analysis.summary
        doc = self.analysis.document

        top_chars = sorted(
            self.analysis.entities.characters,
            key=lambda c: c.stats.total_mentions,
            reverse=True,
        )[:10]

        return {
            "document": {
                "title": doc.title,
                "word_count": doc.word_count,
                "chapter_count": doc.chapter_count,
            },
            "summary": {
                "total_chunks": summary.total_chunks,
                "character_count": summary.character_count,
                "event_count": summary.event_count,
                "issue_count": summary.issue_count,
            },
            "top_characters": [
                {"id": c.id, "name": c.name, "mentions": c.stats.total_mentions}
                for c in top_chars
            ],
            "plot_threads": [
                {"id": t.id, "name": t.name, "status": t.status}
                for t in self.analysis.plot_threads
            ],
        }

    def _tool_compare_character_timelines(self, inputs: dict) -> dict:
        char_id_1 = inputs.get("character_id_1")
        char_id_2 = inputs.get("character_id_2")

        char1 = next((c for c in self.analysis.entities.characters if c.id == char_id_1), None)
        char2 = next((c for c in self.analysis.entities.characters if c.id == char_id_2), None)

        if not char1:
            return {"error": f"Character not found: {char_id_1}"}
        if not char2:
            return {"error": f"Character not found: {char_id_2}"}

        shared_events = [eid for eid in char1.event_ids if eid in char2.event_ids]

        return {
            "character1": {"id": char1.id, "name": char1.name, "event_count": len(char1.event_ids)},
            "character2": {"id": char2.id, "name": char2.name, "event_count": len(char2.event_ids)},
            "shared_event_count": len(shared_events),
        }

    def _tool_report_insight(self, inputs: dict) -> dict:
        insight = CriticInsight(
            type=inputs.get("type", ""),
            severity=inputs.get("severity", ""),
            title=inputs.get("title", ""),
            description=inputs.get("description", ""),
            evidence=inputs.get("evidence", []),
            related_entity_ids=inputs.get("related_entity_ids", []),
        )
        self.insights.append(insight)
        return {"success": True, "total_insights": len(self.insights)}


DEFAULT_MODEL = "claude-sonnet-4-20250514"


def _build_system_prompt(focus_areas: Optional[list[str]] = None) -> str:
    """Build the system prompt for the critic."""
    focus_section = ""
    if focus_areas:
        focus_section = f"\n\n## Focus Areas\nPay special attention to: {', '.join(focus_areas)}"

    return f"""You are an experienced literary critic and editor analyzing a novel manuscript. You have access to a database of extracted information about the manuscript.

Your goal is to identify:
1. Continuity Issues - contradictions, timeline problems
2. Character Development Problems - flat arcs, inconsistent motivations
3. Plot Holes - missing explanations, abandoned setups
4. Pacing Concerns - rushed or slow sections
5. Structural Issues - weak openings, unsatisfying resolutions
6. Strengths - what works well
7. Suggestions - constructive feedback

## Working Method
1. Start by getting a document overview
2. Review existing issues
3. Investigate major characters
4. Trace plot threads
5. Read source text to verify findings
6. Report insights using report_insight

Be thorough but efficient. Always verify by reading source text.{focus_section}

When done, say "Analysis complete"."""


def run_critic(
    analysis: AnalysisOutput,
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    max_iterations: int = 25,
    focus_areas: Optional[list[str]] = None,
    on_progress: Optional[Callable[[CriticProgress], None]] = None,
) -> CriticResult:
    """
    Run the literary critic agent.

    Args:
        analysis: Analysis output to critique
        api_key: Anthropic API key
        model: Model to use
        max_iterations: Maximum agent iterations
        focus_areas: Areas to focus on
        on_progress: Progress callback

    Returns:
        CriticResult with insights and usage
    """
    client = anthropic.Anthropic(api_key=api_key)
    executor = CriticToolExecutor(analysis)
    system_prompt = _build_system_prompt(focus_areas)

    messages: list[MessageParam] = [{
        "role": "user",
        "content": f"""Please analyze this manuscript. The systematic extraction found {analysis.summary.issue_count} issues.

Key stats:
- {analysis.summary.character_count} characters
- {analysis.summary.event_count} events
- {analysis.summary.plot_thread_count} plot threads

Start by getting an overview, then investigate systematically.""",
    }]

    total_input = 0
    total_output = 0
    iteration = 0
    done = False

    if on_progress:
        on_progress(CriticProgress(phase="starting", iteration=0, max_iterations=max_iterations, insights_found=0))

    while not done and iteration < max_iterations:
        iteration += 1

        if on_progress:
            on_progress(CriticProgress(
                phase="investigating",
                iteration=iteration,
                max_iterations=max_iterations,
                insights_found=len(executor.get_insights()),
            ))

        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=system_prompt,
            tools=CRITIC_TOOLS,
            messages=messages,
        )

        total_input += response.usage.input_tokens
        total_output += response.usage.output_tokens

        # Add assistant message
        messages.append({"role": "assistant", "content": response.content})

        # Process tool calls
        tool_results = []
        has_tool_use = False

        for block in response.content:
            if block.type == "tool_use":
                has_tool_use = True
                if on_progress:
                    on_progress(CriticProgress(
                        phase="investigating",
                        iteration=iteration,
                        max_iterations=max_iterations,
                        current_activity=f"Using {block.name}",
                        insights_found=len(executor.get_insights()),
                    ))

                result = executor.execute(block.name, block.input)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

        if tool_results:
            messages.append({"role": "user", "content": tool_results})

        # Check if done
        if response.stop_reason == "end_turn" and not has_tool_use:
            done = True

        # Check for completion phrases
        for block in response.content:
            if isinstance(block, TextBlock):
                text = block.text.lower()
                if any(phrase in text for phrase in [
                    "analysis complete", "completed my analysis",
                    "finished my review", "that concludes"
                ]):
                    done = True

    if on_progress:
        on_progress(CriticProgress(
            phase="complete",
            iteration=iteration,
            max_iterations=max_iterations,
            insights_found=len(executor.get_insights()),
        ))

    return CriticResult(
        insights=executor.get_insights(),
        token_usage={"input_tokens": total_input, "output_tokens": total_output},
        iterations=iteration,
    )


def insights_to_issues(
    insights: list[CriticInsight],
    starting_id: int = 1000,
) -> list[CriticIssue]:
    """Convert critic insights to issue format."""
    severity_map = {
        "critical": "error",
        "important": "warning",
        "minor": "info",
        "observation": "info",
    }

    type_map = {
        "continuity_issue": "continuity_error",
        "character_arc_observation": "character_inconsistency",
        "plot_hole": "unresolved_thread",
        "pacing_concern": "pacing_issue",
        "thematic_insight": "thematic_observation",
        "structural_observation": "structural_issue",
        "strength": "strength",
        "suggestion": "suggestion",
    }

    issues = []
    for i, insight in enumerate(insights):
        chunk_ids = [e.get("chunk_id") for e in insight.evidence if e.get("chunk_id")]
        issues.append(CriticIssue(
            id=f"critic-{starting_id + i}",
            type=type_map.get(insight.type, insight.type),
            severity=severity_map.get(insight.severity, "info"),
            title=insight.title,
            description=insight.description,
            chunk_ids=[cid for cid in chunk_ids if cid is not None],
            evidence=[
                {"quote": e.get("quote", ""), "chunk_id": e.get("chunk_id", ""), "note": e.get("note")}
                for e in insight.evidence
            ],
            related_entity_ids=insight.related_entity_ids,
        ))
    return issues
