#!/usr/bin/env python3
"""
Book Editor CLI - Analyze manuscripts from the command line.
"""

import json
from pathlib import Path

import click

from critic.analyzer import analyze_document
from critic.parser import parse_document
from critic.chunker import chunk_document, ChunkOptions
from critic.cache import AnalysisCache
from critic.critic import run_critic, insights_to_issues
from critic.schema import AnalysisOutput
from critic.inspect import main as inspect_main


@click.group()
@click.version_option(version="0.1.0")
def main():
    """Analyze manuscripts for continuity errors, plot holes, and more."""
    pass


@main.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("-o", "--output", type=click.Path(), help="Output JSON results to file")
@click.option("-m", "--model", default="claude-sonnet-4-20250514", help="Claude model to use")
@click.option("-v", "--verbose", is_flag=True, help="Show detailed progress")
@click.option("--cache/--no-cache", default=True, help="Enable/disable caching")
@click.option("--critic", is_flag=True, help="Run literary critic agent after extraction")
@click.option("--critic-focus", help="Focus areas for critic (comma-separated)")
def analyze(file, output, model, verbose, cache, critic, critic_focus):
    """Analyze a manuscript for issues."""
    file_path = Path(file)
    click.echo(f"Analyzing: {file_path}\n")

    if cache:
        click.echo("Cache enabled (use --no-cache to disable)\n")

    def on_progress(phase, completed, total):
        if verbose:
            pct = round(completed / total * 100) if total > 0 else 0
            click.echo(f"  [{phase}] {completed}/{total} ({pct}%)")

    result = analyze_document(
        file_path,
        model=model,
        cache=cache,
        on_progress=on_progress if verbose else None,
    )

    # Run critic if requested
    if critic:
        click.echo("\nRunning literary critic agent...\n")

        focus_areas = critic_focus.split(",") if critic_focus else None

        def critic_progress(update):
            if verbose:
                click.echo(f"  [critic] Iteration {update.iteration}: {update.current_activity or update.phase}")

        critic_result = run_critic(
            result,
            model=model,
            focus_areas=focus_areas,
            on_progress=critic_progress if verbose else None,
        )

        click.echo(f"Critic found {len(critic_result.insights)} additional insights")
        click.echo(f"  ({critic_result.iterations} iterations, "
                   f"{critic_result.token_usage['input_tokens'] + critic_result.token_usage['output_tokens']} tokens)\n")

    # Print summary
    click.echo("\n=== ANALYSIS COMPLETE ===\n")
    click.echo(f"Document: {result.document.title}")
    click.echo(f"Words: {result.document.word_count:,}")
    click.echo(f"Chapters: {result.document.chapter_count}")
    click.echo(f"Chunks analyzed: {result.summary.total_chunks}\n")

    click.echo("--- Entities ---")
    click.echo(f"Characters: {result.summary.character_count}")
    click.echo(f"Locations: {result.summary.location_count}")
    click.echo(f"Objects: {result.summary.object_count}\n")

    click.echo("--- Story Structure ---")
    click.echo(f"Timeline events: {result.summary.event_count}")
    click.echo(f"Plot threads: {result.summary.plot_thread_count} "
               f"({result.summary.unresolved_thread_count} unresolved)")
    click.echo(f"Setups: {result.summary.setup_count} ({result.summary.unresolved_setup_count} pending)\n")

    click.echo("--- Issues ---")
    click.echo(f"Total: {result.summary.issue_count}")
    click.echo(f"  Errors: {result.summary.issues_by_severity.error}")
    click.echo(f"  Warnings: {result.summary.issues_by_severity.warning}")
    click.echo(f"  Info: {result.summary.issues_by_severity.info}\n")

    # List issues
    if result.issues:
        click.echo("=== ISSUES ===\n")

        for severity in ["error", "warning", "info"]:
            issues = [i for i in result.issues if i.severity == severity]
            if not issues:
                continue

            icons = {"error": "X", "warning": "!", "info": "i"}
            click.echo(f"[{icons[severity]}] {severity.upper()}S ({len(issues)}):\n")

            for issue in issues:
                click.echo(f"  [{issue.type}] {issue.title}")
                click.echo(f"    {issue.description}")
                if issue.evidence:
                    preview = issue.evidence[0].quote[:60]
                    if len(issue.evidence[0].quote) > 60:
                        preview += "..."
                    click.echo(f'    Evidence: "{preview}"')
                click.echo()

    # Output to file
    if output:
        output_path = Path(output)
        output_path.write_text(result.model_dump_json_for_frontend())
        click.echo(f"\nFull analysis saved to: {output_path}")
        click.echo("This file can be loaded directly by the frontend.")
    else:
        click.echo("Use --output <file.json> to save the full analysis.")


@main.command()
@click.argument("file", type=click.Path(exists=True))
def parse(file):
    """Parse a document and show structure (no API calls)."""
    file_path = Path(file)
    doc = parse_document(file_path=file_path)

    click.echo(f"Title: {doc.title}")
    click.echo(f"Paragraphs: {len(doc.paragraphs)}")
    click.echo(f"Headings: {len(doc.headings)}\n")

    if doc.headings:
        click.echo("Headings found:")
        for h in doc.headings:
            click.echo(f"  {'#' * h.level} {h.text} (para {h.paragraph_index})")
        click.echo()

    click.echo("First 500 characters:")
    click.echo(doc.full_text[:500])
    click.echo("...\n")


@main.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("--strategy", type=click.Choice(["chapters", "size", "hybrid"]), default="hybrid")
@click.option("--size", type=int, default=8000, help="Target chunk size")
def chunk(file, strategy, size):
    """Chunk a document and show structure (no API calls)."""
    file_path = Path(file)
    doc = parse_document(file_path=file_path)
    chunks = chunk_document(doc, ChunkOptions(strategy=strategy, target_size=size))

    click.echo(f"Document: {doc.title}")
    click.echo(f"Total chunks: {len(chunks)}\n")

    for c in chunks:
        preview = c.content[:100].replace("\n", " ")
        click.echo(f"{c.id}: {c.title or '(untitled)'}")
        click.echo(f"  Length: {len(c.content)} chars")
        click.echo(f"  Preview: {preview}...")
        click.echo()


@main.command()
@click.argument("analysis_json", type=click.Path(exists=True))
@click.option("-o", "--output", type=click.Path(), help="Output updated JSON")
@click.option("-m", "--model", default="claude-sonnet-4-20250514", help="Claude model to use")
@click.option("-v", "--verbose", is_flag=True, help="Show detailed progress")
@click.option("--focus", help="Focus areas (comma-separated)")
@click.option("--max-iterations", type=int, default=25, help="Maximum agent iterations")
def critic(analysis_json, output, model, verbose, focus, max_iterations):
    """Run the literary critic agent on an existing analysis."""
    file_path = Path(analysis_json)
    click.echo(f"Loading analysis: {file_path}\n")

    data = json.loads(file_path.read_text())
    analysis = AnalysisOutput.model_validate(data)

    click.echo(f"Document: {analysis.document.title}")
    click.echo(f"Existing issues: {len(analysis.issues)}\n")

    click.echo("Running literary critic agent...\n")

    focus_areas = focus.split(",") if focus else None

    def on_progress(update):
        if verbose:
            click.echo(f"  [{update.phase}] Iteration {update.iteration}: "
                       f"{update.current_activity or ''} ({update.insights_found} insights)")
        elif update.current_activity:
            click.echo(f"\r  Iteration {update.iteration}: {update.current_activity}".ljust(60), nl=False)

    result = run_critic(
        analysis,
        model=model,
        max_iterations=max_iterations,
        focus_areas=focus_areas,
        on_progress=on_progress,
    )

    if not verbose:
        click.echo()  # New line after progress

    click.echo(f"\nCritic found {len(result.insights)} insights:")
    click.echo(f"  Tokens: {result.token_usage['input_tokens'] + result.token_usage['output_tokens']:,}")
    click.echo(f"  Iterations: {result.iterations}\n")

    # Group by severity
    severity_groups = {
        "critical": [i for i in result.insights if i.severity == "critical"],
        "important": [i for i in result.insights if i.severity == "important"],
        "minor": [i for i in result.insights if i.severity == "minor"],
        "observation": [i for i in result.insights if i.severity == "observation"],
    }

    icons = {"critical": "!", "important": "*", "minor": ".", "observation": "o"}

    for severity, insights in severity_groups.items():
        if not insights:
            continue

        click.echo(f"[{icons[severity]}] {severity.upper()} ({len(insights)}):\n")
        for insight in insights:
            click.echo(f"  [{insight.type}] {insight.title}")
            desc = insight.description[:200]
            if len(insight.description) > 200:
                desc += "..."
            click.echo(f"    {desc}")
            click.echo()

    # Save if output specified
    if output:
        critic_issues = insights_to_issues(result.insights, len(analysis.issues) + 1)
        output_data = analysis.model_dump()
        output_data["critic_issues"] = [
            {
                "id": i.id,
                "type": i.type,
                "severity": i.severity,
                "title": i.title,
                "description": i.description,
                "chunk_ids": i.chunk_ids,
                "evidence": i.evidence,
                "related_entity_ids": i.related_entity_ids,
            }
            for i in critic_issues
        ]

        output_path = Path(output)
        output_path.write_text(json.dumps(output_data, indent=2))
        click.echo(f"\nUpdated analysis saved to: {output_path}")


@main.command("cache")
@click.option("--stats", is_flag=True, help="Show cache statistics")
@click.option("--clear", is_flag=True, help="Clear all cached data")
@click.option("--dir", "cache_dir", type=click.Path(), help="Cache directory")
def cache_cmd(stats, clear, cache_dir):
    """Manage the analysis cache."""
    cache = AnalysisCache(cache_dir=cache_dir)

    if clear:
        cache.clear()
        click.echo("Cache cleared")
        return

    # Default to showing stats
    cache_stats = cache.get_stats()
    click.echo("Cache Statistics:\n")
    click.echo(f"  Chunks cached: {cache_stats.chunks}")
    click.echo(f"  Discovery results: {cache_stats.discovery}")
    click.echo(f"  Extraction results: {cache_stats.extraction}")
    click.echo(f"  Total size: {cache_stats.total_size}")


# Add inspect subcommands
main.add_command(inspect_main, name="inspect")


if __name__ == "__main__":
    main()
