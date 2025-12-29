#!/usr/bin/env python3
"""
Book Editor CLI - Analyze manuscripts from the command line.
"""

import json
from pathlib import Path

import click

from critic.analyzer import analyze_document
from critic.parser import parse_document
from critic.chunker import chunk_document
from critic.config import DEFAULT_MODEL


@click.group()
@click.version_option(version="0.2.0")
def main():
    """Analyze manuscripts for continuity errors, plot holes, and more."""
    pass


@main.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("-o", "--output", type=click.Path(), help="Output JSON results to file")
@click.option("-m", "--model", default=DEFAULT_MODEL, help="Claude model to use")
@click.option("-v", "--verbose", is_flag=True, help="Show detailed progress")
@click.option("--summarize-only", is_flag=True, help="Only generate summaries, skip critic")
def analyze(file, output, model, verbose, summarize_only):
    """Analyze a manuscript for issues."""
    file_path = Path(file)
    click.echo(f"Analyzing: {file_path}\n")

    def on_progress(phase, completed, total):
        if verbose:
            pct = round(completed / total * 100) if total > 0 else 0
            click.echo(f"  [{phase}] {completed}/{total} ({pct}%)")

    result = analyze_document(
        file_path,
        model=model,
        run_critic_phase=not summarize_only,
        on_progress=on_progress if verbose else None,
    )

    # Print summary
    click.echo("\n=== ANALYSIS COMPLETE ===\n")
    click.echo(f"Document: {result.document.title}")
    click.echo(f"Words: {result.document.word_count:,}")
    click.echo(f"Chapters: {result.summary.chapter_count}\n")

    click.echo("--- Issues ---")
    click.echo(f"Total: {result.summary.issue_count}")
    click.echo(f"  Errors: {result.summary.error_count}")
    click.echo(f"  Warnings: {result.summary.warning_count}")
    click.echo(f"  Suggestions: {result.summary.suggestion_count}\n")

    click.echo("--- Strengths ---")
    click.echo(f"Total: {result.summary.strength_count}\n")

    # List issues
    if result.issues:
        click.echo("=== ISSUES ===\n")

        for severity in ["error", "warning", "suggestion"]:
            issues = [i for i in result.issues if i.severity == severity]
            if not issues:
                continue

            icons = {"error": "X", "warning": "!", "suggestion": "~"}
            click.echo(f"[{icons[severity]}] {severity.upper()}S ({len(issues)}):\n")

            for issue in issues:
                click.echo(f"  [{issue.type}] {issue.title}")
                click.echo(f"    {issue.description}")
                if issue.evidence:
                    quote = issue.evidence[0].quote[:60] if issue.evidence[0].quote else ""
                    if len(quote) > 60:
                        quote += "..."
                    if quote:
                        click.echo(f'    Evidence: "{quote}"')
                click.echo()

    # List strengths
    if result.strengths:
        click.echo("=== STRENGTHS ===\n")
        for strength in result.strengths:
            click.echo(f"  {strength.title}")
            click.echo(f"    {strength.description[:200]}...")
            click.echo()

    # Output to file
    if output:
        output_path = Path(output)
        output_path.write_text(result.to_json())
        click.echo(f"\nFull analysis saved to: {output_path}")
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
def chapters(file):
    """Show chapter structure of a document (no API calls)."""
    file_path = Path(file)
    doc = parse_document(file_path=file_path)
    chunks = chunk_document(doc)

    click.echo(f"Document: {doc.title}")
    click.echo(f"Total chapters: {len(chunks)}\n")

    for c in chunks:
        word_count = len(c.content.split())
        preview = c.content[:100].replace("\n", " ")
        click.echo(f"{c.id}: {c.title or '(untitled)'}")
        click.echo(f"  Words: {word_count:,}")
        click.echo(f"  Preview: {preview}...")
        click.echo()


@main.command()
@click.argument("analysis_json", type=click.Path(exists=True))
def show(analysis_json):
    """Show details of a saved analysis."""
    from critic.schema import AnalysisOutput

    file_path = Path(analysis_json)
    data = json.loads(file_path.read_text())
    result = AnalysisOutput.from_dict(data)

    click.echo(f"Document: {result.document.title}")
    click.echo(f"Analyzed: {result.analyzed_at}")
    click.echo(f"Schema: v{result.schema_version}\n")

    click.echo(f"Chapters: {len(result.chapters)}")
    click.echo(f"Issues: {len(result.issues)}")
    click.echo(f"Strengths: {len(result.strengths)}\n")

    # Show chapters with summaries
    click.echo("=== CHAPTERS ===\n")
    for ch in result.chapters:
        click.echo(f"{ch.id}: {ch.title} ({ch.word_count:,} words)")
        # Show first 200 chars of summary
        preview = ch.summary[:200].replace("\n", " ")
        click.echo(f"  {preview}...")
        click.echo()


@main.command()
@click.argument("file", type=click.Path(exists=True))
@click.option("-o", "--output", type=click.Path(), default="wiki", help="Output directory for wiki")
@click.option("-m", "--model", default=DEFAULT_MODEL, help="Claude model to use")
@click.option("--from-json", is_flag=True, help="Input is analysis JSON instead of manuscript")
def wiki(file, output, model, from_json):
    """Generate a static wiki from a manuscript or analysis JSON."""
    from critic.schema import AnalysisOutput
    from critic.wiki_generator import generate_wiki

    file_path = Path(file)
    output_path = Path(output)

    if from_json:
        # Load existing analysis
        click.echo(f"Loading analysis from: {file_path}\n")
        data = json.loads(file_path.read_text())
        result = AnalysisOutput.from_dict(data)
    else:
        # Run full analysis
        click.echo(f"Analyzing: {file_path}\n")
        result = analyze_document(file_path, model=model)

        click.echo(f"\nAnalysis complete: {result.summary.issue_count} issues, "
                   f"{len(result.wiki.characters)} characters, "
                   f"{len(result.wiki.locations)} locations\n")

    # Generate wiki
    generate_wiki(result, output_path)

    click.echo(f"\nWiki generated at: {output_path}/")
    click.echo(f"Open {output_path}/index.html in a browser to view.")


if __name__ == "__main__":
    main()
