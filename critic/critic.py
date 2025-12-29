"""
Literary Critic Agent - analyzes manuscripts for continuity and craft issues.

Works with prose chapter summaries and can retrieve original chapter text
for verification.
"""

import json
from dataclasses import dataclass, field
from typing import Callable, Optional

import anthropic
from anthropic.types import MessageParam, ToolParam, TextBlock

from critic.types import Chunk
from critic.summarizer import ChapterSummary
from critic.config import DEFAULT_MODEL


# Retrieval tools - only used when full text isn't in context
RETRIEVAL_TOOLS: list[ToolParam] = [
    {
        "name": "read_chapter",
        "description": "Read the full original text of a chapter. Use this to verify details from summaries or find specific quotes.",
        "input_schema": {
            "type": "object",
            "properties": {
                "chapter_id": {
                    "type": "string",
                    "description": "The chapter ID (e.g., 'chapter-1', 'chapter-5')",
                },
            },
            "required": ["chapter_id"],
        },
    },
    {
        "name": "search_chapters",
        "description": "Search for specific text across all chapters. Returns matching excerpts with context.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text to search for (case-insensitive)",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum results to return (default: 10)",
                },
            },
            "required": ["query"],
        },
    },
]

# Reporting tools - always available
REPORTING_TOOLS: list[ToolParam] = [
    {
        "name": "report_issue",
        "description": "Report a continuity issue, plot hole, or other problem found in the manuscript.",
        "input_schema": {
            "type": "object",
            "properties": {
                "type": {
                    "type": "string",
                    "enum": [
                        "continuity_error",
                        "timeline_inconsistency",
                        "character_inconsistency",
                        "plot_hole",
                        "unresolved_thread",
                        "dropped_character",
                        "factual_contradiction",
                        "pacing_issue",
                        "age_arithmetic",
                        "unexplained_transformation",
                        "narrator_reliability",
                        "other",
                    ],
                    "description": "Type of issue",
                },
                "severity": {
                    "type": "string",
                    "enum": ["error", "warning", "suggestion"],
                    "description": "How serious is this issue?",
                },
                "title": {
                    "type": "string",
                    "description": "Brief title for the issue",
                },
                "description": {
                    "type": "string",
                    "description": "Detailed explanation of the issue",
                },
                "evidence": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "chapter_id": {"type": "string"},
                            "quote": {"type": "string"},
                            "note": {"type": "string"},
                        },
                    },
                    "description": "Evidence supporting this issue (quotes from the text)",
                },
            },
            "required": ["type", "severity", "title", "description"],
        },
    },
    {
        "name": "report_strength",
        "description": "Report something the manuscript does well.",
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Brief title",
                },
                "description": {
                    "type": "string",
                    "description": "What works well and why",
                },
                "examples": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "chapter_id": {"type": "string"},
                            "quote": {"type": "string"},
                        },
                    },
                    "description": "Examples from the text",
                },
            },
            "required": ["title", "description"],
        },
    },
]


@dataclass
class Issue:
    """An issue found by the critic."""
    id: str
    type: str
    severity: str
    title: str
    description: str
    evidence: list[dict] = field(default_factory=list)


@dataclass
class Strength:
    """A strength identified by the critic."""
    title: str
    description: str
    examples: list[dict] = field(default_factory=list)


@dataclass
class CriticResult:
    """Result of running the critic."""
    issues: list[Issue]
    strengths: list[Strength]
    token_usage: dict
    iterations: int


class CriticToolExecutor:
    """Executes critic tools against chapter data."""

    def __init__(
        self,
        chapters: list[Chunk],
        summaries: list[ChapterSummary],
    ):
        self.chapters = {c.id: c for c in chapters}
        self.summaries = {s.chapter_id: s for s in summaries}
        self.issues: list[Issue] = []
        self.strengths: list[Strength] = []
        self._issue_counter = 0

    def execute(self, tool_name: str, inputs: dict) -> str:
        """Execute a tool and return result."""
        method = getattr(self, f"_tool_{tool_name}", None)
        if method:
            return json.dumps(method(inputs))
        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def _tool_read_chapter(self, inputs: dict) -> dict:
        chapter_id = inputs.get("chapter_id", "")
        chapter = self.chapters.get(chapter_id)

        if not chapter:
            # Try to find by partial match
            matches = [c for c in self.chapters.values()
                       if chapter_id.lower() in c.id.lower()]
            if len(matches) == 1:
                chapter = matches[0]
            elif matches:
                return {
                    "error": f"Ambiguous chapter ID. Did you mean: {[c.id for c in matches[:5]]}?"
                }
            else:
                return {
                    "error": f"Chapter not found: {chapter_id}",
                    "available": list(self.chapters.keys())[:10],
                }

        return {
            "chapter_id": chapter.id,
            "title": chapter.title,
            "text": chapter.content,
            "word_count": len(chapter.content.split()),
        }

    def _tool_search_chapters(self, inputs: dict) -> dict:
        query = inputs.get("query", "").lower()
        max_results = inputs.get("max_results", 10)

        if not query:
            return {"error": "Query is required"}

        results = []
        for chapter in self.chapters.values():
            text_lower = chapter.content.lower()
            pos = 0
            while len(results) < max_results:
                idx = text_lower.find(query, pos)
                if idx == -1:
                    break

                # Extract context
                start = max(0, idx - 100)
                end = min(len(chapter.content), idx + len(query) + 100)
                excerpt = chapter.content[start:end]

                # Add ellipsis if truncated
                if start > 0:
                    excerpt = "..." + excerpt
                if end < len(chapter.content):
                    excerpt = excerpt + "..."

                results.append({
                    "chapter_id": chapter.id,
                    "chapter_title": chapter.title,
                    "excerpt": excerpt,
                })

                pos = idx + 1

            if len(results) >= max_results:
                break

        return {
            "query": query,
            "results": results,
            "total_found": len(results),
        }

    def _tool_report_issue(self, inputs: dict) -> dict:
        self._issue_counter += 1
        issue = Issue(
            id=f"issue-{self._issue_counter}",
            type=inputs.get("type", "other"),
            severity=inputs.get("severity", "warning"),
            title=inputs.get("title", ""),
            description=inputs.get("description", ""),
            evidence=inputs.get("evidence", []),
        )
        self.issues.append(issue)
        return {"success": True, "issue_id": issue.id, "total_issues": len(self.issues)}

    def _tool_report_strength(self, inputs: dict) -> dict:
        strength = Strength(
            title=inputs.get("title", ""),
            description=inputs.get("description", ""),
            examples=inputs.get("examples", []),
        )
        self.strengths.append(strength)
        return {"success": True, "total_strengths": len(self.strengths)}


def _build_system_prompt(
    manuscript_map: str,
    full_chapters: Optional[str] = None,
) -> str:
    """Build the system prompt with the manuscript map and optionally full text."""

    if full_chapters:
        # Full text is included - no need for retrieval tools
        return f"""You are an experienced literary editor analyzing a manuscript for continuity issues and craft problems.

You have been given:
1. **Summaries** of each chapter (for quick reference)
2. **Full original text** of each chapter (for verification and quotes)

Your job is to:
1. **Find Continuity Issues**: Look for contradictions in character descriptions, timeline problems, factual inconsistencies
2. **Identify Plot Problems**: Unresolved threads, dropped characters, plot holes, abandoned setups
3. **Note Craft Concerns**: Pacing issues, character development problems, structural weaknesses
4. **Recognize Strengths**: What does the manuscript do well?

## CRITICAL: Age & Timeline Arithmetic
You MUST explicitly calculate and verify:
- Character ages across the timeline (if X is 12 in chapter 3 and 10 years pass, X should be 22)
- Whether stated ages match the events described
- Whether time spans add up correctly
- If a narrator claims to remember events from X years ago, are they old enough?

## CRITICAL: Unexplained Transformations
Flag when characters undergo major changes without explanation:
- Sudden wealth (how did they get rich?)
- Sudden education/refinement (where did they learn this?)
- Unexplained absences (where were they? what happened?)
- New skills/knowledge with no acquisition shown

## CRITICAL: Narrator Reliability
Question the plausibility of narration:
- Can the narrator actually know what they claim to know?
- Are they present at scenes they describe in detail?
- Is their memory of old events suspiciously perfect?
- Do they report private conversations they couldn't have witnessed?

## Your Process

1. Read through the chapter summaries to understand the story
2. When you spot a potential issue, check the original text to verify
3. Use `report_issue` to log each real problem (with exact quotes as evidence!)
4. Use `report_strength` to note what works well

## Important Guidelines

- Verify issues against the original text before reporting
- Include exact quotes from the original text as evidence
- Be thorough but avoid false positives
- Focus on issues that would matter to a reader or editor

When you have thoroughly analyzed the manuscript, say "Analysis complete."

---

# CHAPTER SUMMARIES

{manuscript_map}

---

# FULL CHAPTER TEXT

{full_chapters}"""
    else:
        # Full text not included - use retrieval tools
        return f"""You are an experienced literary editor analyzing a manuscript for continuity issues and craft problems.

You have been given summaries of each chapter below. Your job is to:

1. **Find Continuity Issues**: Look for contradictions in character descriptions, timeline problems, factual inconsistencies, etc.
2. **Identify Plot Problems**: Unresolved threads, dropped characters, plot holes, abandoned setups
3. **Note Craft Concerns**: Pacing issues, character development problems, structural weaknesses
4. **Recognize Strengths**: What does the manuscript do well?

## CRITICAL: Age & Timeline Arithmetic
You MUST explicitly calculate and verify:
- Character ages across the timeline (if X is 12 in chapter 3 and 10 years pass, X should be 22)
- Whether stated ages match the events described
- Whether time spans add up correctly
- If a narrator claims to remember events from X years ago, are they old enough?

## CRITICAL: Unexplained Transformations
Flag when characters undergo major changes without explanation:
- Sudden wealth (how did they get rich?)
- Sudden education/refinement (where did they learn this?)
- Unexplained absences (where were they? what happened?)
- New skills/knowledge with no acquisition shown

## CRITICAL: Narrator Reliability
Question the plausibility of narration:
- Can the narrator actually know what they claim to know?
- Are they present at scenes they describe in detail?
- Is their memory of old events suspiciously perfect?
- Do they report private conversations they couldn't have witnessed?

## Your Process

1. Read through the chapter summaries carefully
2. Note any potential issues you spot
3. Use `search_chapters` to find specific mentions when you need to verify something
4. Use `read_chapter` to get the full original text when you need exact quotes
5. Use `report_issue` to log each problem you find (with evidence!)
6. Use `report_strength` to note what works well

## Important Guidelines

- Always verify issues by checking the original text before reporting
- Include specific quotes as evidence
- Be thorough but avoid false positives - only report real issues
- Focus on issues that would matter to a reader or editor

When you have thoroughly analyzed the manuscript, say "Analysis complete."

---

# MANUSCRIPT SUMMARIES

{manuscript_map}"""


# Threshold for including full text in system prompt (in estimated tokens)
# Below this, we include full text and it gets cached
# Above this, we use two-phase discovery + verification
FULL_TEXT_THRESHOLD = 120000  # ~120K tokens leaves room for conversation


def run_critic(
    chapters: list[Chunk],
    summaries: list[ChapterSummary],
    api_key: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    max_iterations: int = 50,
    on_progress: Optional[Callable[[int, int, str], None]] = None,
) -> CriticResult:
    """
    Run the literary critic agent on chapter summaries.

    For manuscripts under ~120K tokens, includes full text in the cached
    system prompt for efficiency. Larger manuscripts use a two-phase approach:
    1. Discovery: identify potential issues from summaries
    2. Verification: verify each issue with relevant chapters (each call independent)

    Args:
        chapters: Original chapter chunks (for text retrieval)
        summaries: Chapter summaries from the summarizer
        api_key: Anthropic API key
        model: Model to use
        max_iterations: Maximum agent loop iterations
        on_progress: Callback (iteration, max_iterations, current_activity)

    Returns:
        CriticResult with issues and strengths
    """
    # Build the manuscript map from summaries
    manuscript_map = "\n\n---\n\n".join(
        f"## {s.chapter_title}\n\n{s.summary}"
        for s in summaries
    )

    # Build full chapter text
    full_chapters = "\n\n---\n\n".join(
        f"## {c.title or c.id}\n\n{c.content}"
        for c in chapters
    )

    # Estimate total tokens
    total_content = manuscript_map + full_chapters
    estimated_tokens = len(total_content) // 4

    # Decide which approach to use
    if estimated_tokens < FULL_TEXT_THRESHOLD:
        # Small manuscript: include full text, everything cached
        print(f"[Critic] Full text in context: ~{estimated_tokens:,} tokens (cached)")
        return _run_critic_full_context(
            chapters, summaries, manuscript_map, full_chapters,
            api_key, model, max_iterations, on_progress
        )
    else:
        # Large manuscript: two-phase discovery + verification
        summary_tokens = len(manuscript_map) // 4
        print(f"[Critic] Two-phase mode: ~{summary_tokens:,} tokens summaries, {len(chapters)} chapters")
        return _run_critic_two_phase(
            chapters, summaries, manuscript_map,
            api_key, model, max_iterations, on_progress
        )


def _run_critic_full_context(
    chapters: list[Chunk],
    summaries: list[ChapterSummary],
    manuscript_map: str,
    full_chapters: str,
    api_key: Optional[str],
    model: str,
    max_iterations: int,
    on_progress: Optional[Callable[[int, int, str], None]],
) -> CriticResult:
    """Run critic with full text in context (for smaller manuscripts)."""
    client = anthropic.Anthropic(api_key=api_key)
    executor = CriticToolExecutor(chapters, summaries)

    system_prompt = _build_system_prompt(manuscript_map, full_chapters)

    messages: list[MessageParam] = [{
        "role": "user",
        "content": f"Please analyze this {len(chapters)}-chapter manuscript for issues. Start by reviewing the summaries, then investigate anything that looks suspicious.",
    }]

    total_input = 0
    total_output = 0
    iteration = 0

    # Only reporting tools when full text is in context
    tools = REPORTING_TOOLS

    while iteration < max_iterations:
        iteration += 1

        if on_progress:
            on_progress(iteration, max_iterations, "thinking")

        response = client.messages.create(
            model=model,
            max_tokens=4096,
            system=[{
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=tools,
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
                    on_progress(iteration, max_iterations, f"using {block.name}")

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
            break

        # Check for completion phrases
        for block in response.content:
            if isinstance(block, TextBlock):
                text = block.text.lower()
                if "analysis complete" in text:
                    if not has_tool_use:
                        break

    print(f"[Critic] Completed in {iteration} iterations")
    print(f"[Critic] Found {len(executor.issues)} issues, {len(executor.strengths)} strengths")

    return CriticResult(
        issues=executor.issues,
        strengths=executor.strengths,
        token_usage={"input_tokens": total_input, "output_tokens": total_output},
        iterations=iteration,
    )


def _run_critic_two_phase(
    chapters: list[Chunk],
    summaries: list[ChapterSummary],
    manuscript_map: str,
    api_key: Optional[str],
    model: str,
    max_iterations: int,
    on_progress: Optional[Callable[[int, int, str], None]],
) -> CriticResult:
    """
    Run critic in two phases for large manuscripts.

    Phase 1: Discovery - identify potential issues from summaries only
    Phase 2: Verification - verify each issue with relevant chapter text

    Each verification is an independent API call with:
    - System prompt: summaries + relevant chapters (both cached)
    - User message: just the verification question
    """
    client = anthropic.Anthropic(api_key=api_key)
    chapter_map = {c.id: c for c in chapters}

    total_input = 0
    total_output = 0

    # Phase 1: Discovery - find potential issues from summaries
    print("[Critic] Phase 1: Discovering potential issues from summaries...")

    discovery_prompt = f"""You are an experienced literary editor analyzing a manuscript for continuity issues.

You have been given summaries of each chapter. Your job is to identify ALL potential issues that warrant investigation.

## CRITICAL CHECKS TO PERFORM:

1. **Age Arithmetic**: Calculate character ages across the timeline. If someone is 12 when X happens, and 10 years pass, they should be 22. Flag any discrepancies.

2. **Unexplained Transformations**: Flag when characters undergo major unexplained changes:
   - Sudden wealth with no explanation of source
   - Sudden education/refinement after being uneducated
   - Unexplained absences (where were they? what happened?)

3. **Narrator Reliability**: Question whether the narrator can plausibly know what they claim:
   - Are they old enough to remember what they describe?
   - Were they present at private scenes they narrate?
   - Is their recall of decades-old conversations realistic?

4. **Standard Continuity**: Physical descriptions, timeline sequence, factual consistency.

For each potential issue, output a JSON object with:
- "type": the issue type (timeline_inconsistency, character_inconsistency, plot_hole, unexplained_transformation, narrator_reliability, age_arithmetic, etc.)
- "title": brief description
- "description": what seems wrong (include your arithmetic if applicable)
- "chapter_ids": which chapters to check (e.g., ["chapter-3", "chapter-7"])

Output your findings as a JSON array. Be thorough - it's better to flag something that turns out to be fine than to miss a real issue.

Also identify strengths in the manuscript.

---

# MANUSCRIPT SUMMARIES

{manuscript_map}"""

    discovery_response = client.messages.create(
        model=model,
        max_tokens=8192,
        system=[{
            "type": "text",
            "text": discovery_prompt,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": "Analyze these chapter summaries and identify all potential continuity issues, plot holes, and character inconsistencies. Also note the manuscript's strengths. Output as JSON.",
        }],
    )

    total_input += discovery_response.usage.input_tokens
    total_output += discovery_response.usage.output_tokens

    # Parse discovered issues
    discovery_text = ""
    if discovery_response.content and isinstance(discovery_response.content[0], TextBlock):
        discovery_text = discovery_response.content[0].text
    potential_issues = _parse_discovered_issues(discovery_text)

    print(f"[Critic] Found {len(potential_issues)} potential issues to verify")

    if on_progress:
        on_progress(1, len(potential_issues) + 1, "discovery complete")

    # Phase 2: Verify each issue with relevant chapter text
    verified_issues: list[Issue] = []
    strengths: list[Strength] = []
    issue_counter = 0

    for i, potential in enumerate(potential_issues):
        if on_progress:
            on_progress(i + 2, len(potential_issues) + 1, f"verifying: {potential.get('title', '')[:30]}")

        # Get relevant chapter text
        chapter_ids = potential.get("chapter_ids", [])
        relevant_text = "\n\n---\n\n".join(
            f"## {chapter_map[cid].title or cid}\n\n{chapter_map[cid].content}"
            for cid in chapter_ids
            if cid in chapter_map
        )

        if not relevant_text:
            continue

        # Verification call - summaries + relevant chapters in system prompt
        verify_prompt = f"""You are verifying a potential issue in a manuscript.

# MANUSCRIPT SUMMARIES (for context)

{manuscript_map}

---

# RELEVANT CHAPTER TEXT

{relevant_text}"""

        verify_response = client.messages.create(
            model=model,
            max_tokens=2048,
            system=[{
                "type": "text",
                "text": verify_prompt,
                "cache_control": {"type": "ephemeral"},
            }],
            messages=[{
                "role": "user",
                "content": f"""Verify this potential issue:

Type: {potential.get('type', 'unknown')}
Title: {potential.get('title', '')}
Description: {potential.get('description', '')}

Is this a real issue? If yes, provide:
1. Severity (error, warning, or suggestion)
2. Exact quotes from the text as evidence
3. A clear explanation

If it's NOT a real issue (false positive), explain why.

Respond with JSON: {{"is_issue": true/false, "severity": "...", "evidence": [...], "explanation": "..."}}""",
            }],
        )

        total_input += verify_response.usage.input_tokens
        total_output += verify_response.usage.output_tokens

        # Parse verification result
        verify_text = ""
        if verify_response.content and isinstance(verify_response.content[0], TextBlock):
            verify_text = verify_response.content[0].text
        verification = _parse_verification(verify_text)

        if verification.get("is_issue"):
            issue_counter += 1
            verified_issues.append(Issue(
                id=f"issue-{issue_counter}",
                type=potential.get("type", "other"),
                severity=verification.get("severity", "warning"),
                title=potential.get("title", ""),
                description=verification.get("explanation", potential.get("description", "")),
                evidence=[
                    {"chapter_id": cid, "quote": e.get("quote", "") if isinstance(e, dict) else str(e), "note": e.get("note", "") if isinstance(e, dict) else ""}
                    for cid in chapter_ids
                    for e in verification.get("evidence", [])
                ],
            ))

    # Extract strengths from discovery response
    strengths = _parse_strengths(discovery_text)

    print(f"[Critic] Verified {len(verified_issues)} issues, {len(strengths)} strengths")

    return CriticResult(
        issues=verified_issues,
        strengths=strengths,
        token_usage={"input_tokens": total_input, "output_tokens": total_output},
        iterations=len(potential_issues) + 1,
    )


def _parse_discovered_issues(text: str) -> list[dict]:
    """Parse potential issues from discovery response."""
    import re

    # Try to find JSON array in the response
    match = re.search(r'\[[\s\S]*\]', text)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    # Fallback: return empty list
    return []


def _parse_verification(text: str) -> dict:
    """Parse verification result."""
    import re

    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    # Try to infer from text
    is_issue = "is a real issue" in text.lower() or "is_issue\": true" in text.lower()
    return {"is_issue": is_issue, "explanation": text[:500]}


def _parse_strengths(text: str) -> list[Strength]:
    """Parse strengths from discovery response."""
    # Look for strength mentions in the text
    strengths = []

    # Simple heuristic: look for "strength" mentions
    if "strength" in text.lower():
        # Try to extract from JSON
        import re
        match = re.search(r'"strengths"\s*:\s*\[[\s\S]*?\]', text)
        if match:
            try:
                data = json.loads("{" + match.group(0) + "}")
                for s in data.get("strengths", []):
                    strengths.append(Strength(
                        title=s.get("title", ""),
                        description=s.get("description", ""),
                    ))
            except json.JSONDecodeError:
                pass

    return strengths
