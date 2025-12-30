"""
Static wiki generator - creates HTML pages from analysis output.

Generates a complete static site with:
- Home page (index.html)
- Character articles
- Location articles
- Chapter articles
- Issues page
- Timeline page
"""

import html
import re
from pathlib import Path

import markdown

from critic.schema import (
    AnalysisOutput,
    WikiCharacter,
    WikiLocation,
    ChapterInfo,
    Issue,
    Strength,
)


def slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    text = text.lower()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    return text.strip('-')


def escape(text: str) -> str:
    """HTML escape text."""
    return html.escape(text) if text else ""


CSS = """
:root {
  --link-color: #0645ad;
  --link-visited: #0b0080;
  --border-color: #a2a9b1;
  --bg-light: #f8f9fa;
  --text-muted: #54595d;
  --error-color: #c33;
  --warning-color: #f28500;
  --suggestion-color: #36c;
  --success-color: #006400;
}

* { box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Lato, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  max-width: 960px;
  margin: 0 auto;
  padding: 1rem 2rem;
  color: #202122;
}

a { color: var(--link-color); text-decoration: none; }
a:hover { text-decoration: underline; }
a:visited { color: var(--link-visited); }

h1 {
  font-family: 'Linux Libertine', 'Georgia', serif;
  font-weight: 400;
  font-size: 2rem;
  border-bottom: 1px solid var(--border-color);
  padding-bottom: 0.5rem;
  margin: 0 0 1rem;
}

h2 {
  font-family: 'Linux Libertine', 'Georgia', serif;
  font-weight: 400;
  font-size: 1.5rem;
  border-bottom: 1px solid #eaecf0;
  padding-bottom: 0.25rem;
  margin: 1.5rem 0 0.75rem;
}

h3 { font-size: 1.15rem; margin: 1.25rem 0 0.5rem; }

nav.breadcrumb {
  font-size: 0.9rem;
  margin-bottom: 1rem;
  color: var(--text-muted);
}

nav.breadcrumb a { margin: 0 0.25rem; }

.infobox {
  float: right;
  clear: right;
  width: 260px;
  margin: 0 0 1rem 1.5rem;
  border: 1px solid var(--border-color);
  background: var(--bg-light);
  font-size: 0.9rem;
}

.infobox-header {
  background: #cedff2;
  padding: 0.5rem;
  text-align: center;
  font-weight: 600;
}

.infobox-row {
  padding: 0.4rem 0.6rem;
  border-top: 1px solid var(--border-color);
}

.infobox-label { font-weight: 600; color: var(--text-muted); }

.toc {
  background: var(--bg-light);
  border: 1px solid var(--border-color);
  padding: 0.75rem 1rem;
  display: inline-block;
  margin: 1rem 0;
}

.toc-title { font-weight: 600; margin-bottom: 0.5rem; }
.toc ol { margin: 0; padding-left: 1.5rem; }
.toc li { margin: 0.2rem 0; }

table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid var(--border-color); padding: 0.5rem; text-align: left; vertical-align: top; }
th { background: #eaecf0; }

.lead { font-size: 1.05rem; }

.card {
  background: var(--bg-light);
  border-left: 4px solid var(--border-color);
  padding: 1rem 1.5rem;
  margin: 1rem 0;
}

.card.error { border-left-color: var(--error-color); }
.card.warning { border-left-color: var(--warning-color); }
.card.suggestion { border-left-color: var(--suggestion-color); }
.card.strength { border-left-color: var(--success-color); background: #f0fff0; }

.card h3 { margin: 0 0 0.5rem; font-size: 1.1rem; }
.card-meta { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem; }

blockquote {
  margin: 0.5rem 0;
  padding: 0.5rem 1rem;
  background: #fff;
  border-left: 2px solid #c8ccd1;
  font-style: italic;
  color: var(--text-muted);
}

.severity-error { color: var(--error-color); }
.severity-warning { color: var(--warning-color); }
.severity-suggestion { color: var(--suggestion-color); }

.tag {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 3px;
  font-size: 0.8rem;
  margin-right: 0.5rem;
}
.tag.major { background: #d4edda; color: #155724; }
.tag.minor { background: #fff3cd; color: #856404; }
.tag.mentioned { background: #e2e3e5; color: #383d41; }
.tag.flashback { background: #cce5ff; color: #004085; }

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 1rem;
  margin: 1rem 0;
}

.stat-box {
  background: var(--bg-light);
  border: 1px solid #eaecf0;
  padding: 1rem;
  text-align: center;
}

.stat-value { font-size: 1.75rem; font-weight: 600; color: var(--link-color); }
.stat-label { font-size: 0.85rem; color: var(--text-muted); }

.chapter-nav {
  display: flex;
  justify-content: space-between;
  padding: 0.75rem 0;
  border-bottom: 1px solid #eaecf0;
  margin-bottom: 1rem;
}

.chapter-summary {
  background: var(--bg-light);
  border-left: 3px solid var(--border-color);
  padding: 1rem 1.5rem;
  margin: 1rem 0;
}

footer {
  margin-top: 3rem;
  padding-top: 1rem;
  border-top: 1px solid #eaecf0;
  font-size: 0.85rem;
  color: var(--text-muted);
}

@media (max-width: 700px) {
  .infobox { float: none; width: 100%; margin: 1rem 0; }
  body { padding: 1rem; }
}
"""


class WikiGenerator:
    """Generates static HTML wiki from analysis output."""

    def __init__(self, analysis: AnalysisOutput):
        self.analysis = analysis
        self.title = analysis.document.title

    def generate(self, output_dir: Path) -> None:
        """Generate all wiki pages to output directory."""
        output_dir.mkdir(parents=True, exist_ok=True)

        # Write CSS
        (output_dir / "style.css").write_text(CSS)

        # Generate pages
        self._write(output_dir / "index.html", self._render_home())
        self._write(output_dir / "issues.html", self._render_issues())
        self._write(output_dir / "timeline.html", self._render_timeline())

        # Character pages
        chars_dir = output_dir / "characters"
        chars_dir.mkdir(exist_ok=True)
        for char in self.analysis.wiki.characters:
            slug = slugify(char.name)
            self._write(chars_dir / f"{slug}.html", self._render_character(char))

        # Location pages
        locs_dir = output_dir / "locations"
        locs_dir.mkdir(exist_ok=True)
        for loc in self.analysis.wiki.locations:
            slug = slugify(loc.name)
            self._write(locs_dir / f"{slug}.html", self._render_location(loc))

        # Chapter pages
        chapters_dir = output_dir / "chapters"
        chapters_dir.mkdir(exist_ok=True)
        for chapter in self.analysis.chapters:
            slug = slugify(chapter.id)
            self._write(chapters_dir / f"{slug}.html", self._render_chapter(chapter))

        print(f"[Wiki] Generated {self._count_pages()} pages to {output_dir}")

    def _count_pages(self) -> int:
        return (3 +  # index, issues, timeline
                len(self.analysis.wiki.characters) +
                len(self.analysis.wiki.locations) +
                len(self.analysis.chapters))

    def _write(self, path: Path, content: str) -> None:
        path.write_text(content, encoding='utf-8')

    def _page(self, title: str, content: str, breadcrumbs: list[tuple[str, str]] | None = None) -> str:
        """Wrap content in full HTML page."""
        bc = ""
        if breadcrumbs:
            links = [f'<a href="{href}">{text}</a>' for href, text in breadcrumbs]
            bc = f'<nav class="breadcrumb">{" / ".join(links)}</nav>'

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{escape(title)} - {escape(self.title)} Wiki</title>
  <link rel="stylesheet" href="{self._css_path(breadcrumbs)}style.css">
</head>
<body>
{bc}
{content}
<footer>
  Generated from <strong>{escape(self.title)}</strong> analysis
</footer>
</body>
</html>"""

    def _css_path(self, breadcrumbs: list[tuple[str, str]] | None) -> str:
        """Get relative path to CSS based on page depth."""
        if not breadcrumbs or len(breadcrumbs) <= 1:
            return ""
        return "../"

    def _char_link(self, name: str) -> str:
        """Generate link to character page."""
        slug = slugify(name)
        return f'<a href="characters/{slug}.html">{escape(name)}</a>'

    def _loc_link(self, name: str) -> str:
        """Generate link to location page."""
        slug = slugify(name)
        return f'<a href="locations/{slug}.html">{escape(name)}</a>'

    def _chapter_link(self, chapter_id: str, from_subdir: bool = False) -> str:
        """Generate link to chapter page."""
        chapter = next((c for c in self.analysis.chapters if c.id == chapter_id), None)
        title = chapter.title if chapter else chapter_id
        slug = slugify(chapter_id)
        prefix = "../" if from_subdir else ""
        return f'<a href="{prefix}chapters/{slug}.html">{escape(title)}</a>'

    def _render_home(self) -> str:
        doc = self.analysis.document
        summary = self.analysis.summary
        wiki = self.analysis.wiki

        chars_list = "\n".join(
            f'<li>{self._char_link(c.name)}'
            f'{" — " + escape(c.description[:120]) + "..." if c.description else ""}</li>'
            for c in wiki.characters
        )

        locs_list = "\n".join(
            f'<li>{self._loc_link(loc.name)}'
            f'{" — " + escape(loc.description[:120]) + "..." if loc.description else ""}</li>'
            for loc in wiki.locations
        )

        chapters_list = "\n".join(
            f'<li>{self._chapter_link(c.id)} ({c.word_count:,} words)</li>'
            for c in self.analysis.chapters
        )

        content = f"""
<h1>{escape(doc.title)}</h1>

<p class="lead">
  <strong>{escape(doc.title)}</strong> is a work containing
  <strong>{doc.word_count:,}</strong> words across
  <strong>{len(self.analysis.chapters)}</strong> chapters.
</p>

<div class="toc">
  <div class="toc-title">Contents</div>
  <ol>
    <li><a href="#summary">Summary</a></li>
    <li><a href="#chapters">Chapters</a></li>
    <li><a href="#characters">Characters</a></li>
    <li><a href="#locations">Locations</a></li>
    <li><a href="#analysis">Analysis</a></li>
  </ol>
</div>

<h2 id="summary">Summary</h2>
<div class="stats-grid">
  <div class="stat-box"><div class="stat-value">{len(self.analysis.chapters)}</div><div class="stat-label">Chapters</div></div>
  <div class="stat-box"><div class="stat-value">{len(wiki.characters)}</div><div class="stat-label">Characters</div></div>
  <div class="stat-box"><div class="stat-value">{len(wiki.locations)}</div><div class="stat-label">Locations</div></div>
  <div class="stat-box"><div class="stat-value">{len(wiki.timeline)}</div><div class="stat-label">Events</div></div>
</div>

<h2 id="chapters">Chapters</h2>
<ol>{chapters_list}</ol>

<h2 id="characters">Characters</h2>
<ul>{chars_list}</ul>

<h2 id="locations">Locations</h2>
<ul>{locs_list}</ul>

<h2 id="analysis">Analysis</h2>
<p>
  The manuscript analysis identified
  <a href="issues.html">{summary.issue_count} potential issues</a> and
  {len(self.analysis.strengths)} notable strengths.
  See also the <a href="timeline.html">timeline of {len(wiki.timeline)} events</a>.
</p>
<ul>
  <li class="severity-error"><a href="issues.html#errors">{summary.error_count} errors</a></li>
  <li class="severity-warning"><a href="issues.html#warnings">{summary.warning_count} warnings</a></li>
  <li class="severity-suggestion"><a href="issues.html#suggestions">{summary.suggestion_count} suggestions</a></li>
</ul>
"""
        return self._page(doc.title, content)

    def _render_issues(self) -> str:
        issues = self.analysis.issues
        strengths = self.analysis.strengths
        summary = self.analysis.summary

        errors = [i for i in issues if i.severity == 'error']
        warnings = [i for i in issues if i.severity == 'warning']
        suggestions = [i for i in issues if i.severity == 'suggestion']

        def render_issue(issue: Issue) -> str:
            evidence_html = ""
            if issue.evidence:
                ev_items: list[str] = []
                for ev in issue.evidence:
                    parts: list[str] = []
                    if ev.quote:
                        parts.append(f'<blockquote>"{escape(ev.quote)}"</blockquote>')
                    if ev.note:
                        parts.append(f'<p>{escape(ev.note)}</p>')
                    if ev.chapter_id:
                        parts.append(f'<p><small>Source: {self._chapter_link(ev.chapter_id)}</small></p>')
                    ev_items.append("".join(parts))
                evidence_html = f'<div class="evidence">{"".join(ev_items)}</div>'

            return f"""
<div class="card {issue.severity}">
  <h3>{escape(issue.title)}</h3>
  <div class="card-meta">{escape(issue.type.replace('_', ' '))} · <span class="severity-{issue.severity}">{issue.severity}</span></div>
  <p>{escape(issue.description)}</p>
  {evidence_html}
</div>"""

        def render_strength(s: Strength) -> str:
            return f"""
<div class="card strength">
  <h3>{escape(s.title)}</h3>
  <p>{escape(s.description)}</p>
</div>"""

        sections = []
        if errors:
            sections.append(f'<h2 id="errors" class="severity-error">Errors ({len(errors)})</h2>')
            sections.extend(render_issue(i) for i in errors)
        if warnings:
            sections.append(f'<h2 id="warnings" class="severity-warning">Warnings ({len(warnings)})</h2>')
            sections.extend(render_issue(i) for i in warnings)
        if suggestions:
            sections.append(f'<h2 id="suggestions" class="severity-suggestion">Suggestions ({len(suggestions)})</h2>')
            sections.extend(render_issue(i) for i in suggestions)
        if strengths:
            sections.append(f'<h2 id="strengths">Strengths ({len(strengths)})</h2>')
            sections.extend(render_strength(s) for s in strengths)

        toc_items = []
        if errors:
            toc_items.append(f'<li><a href="#errors">Errors ({len(errors)})</a></li>')
        if warnings:
            toc_items.append(f'<li><a href="#warnings">Warnings ({len(warnings)})</a></li>')
        if suggestions:
            toc_items.append(f'<li><a href="#suggestions">Suggestions ({len(suggestions)})</a></li>')
        if strengths:
            toc_items.append(f'<li><a href="#strengths">Strengths ({len(strengths)})</a></li>')

        content = f"""
<h1>Issues & Strengths</h1>

<p class="lead">
  Analysis identified <strong>{summary.issue_count} issues</strong> and
  <strong>{len(strengths)} strengths</strong>.
</p>

<table>
  <tr><th>Total Issues</th><td>{summary.issue_count}</td></tr>
  <tr class="severity-error"><th>Errors</th><td>{summary.error_count}</td></tr>
  <tr class="severity-warning"><th>Warnings</th><td>{summary.warning_count}</td></tr>
  <tr class="severity-suggestion"><th>Suggestions</th><td>{summary.suggestion_count}</td></tr>
  <tr><th>Strengths</th><td>{len(strengths)}</td></tr>
</table>

<div class="toc">
  <div class="toc-title">Contents</div>
  <ol>{"".join(toc_items)}</ol>
</div>

{"".join(sections)}
"""
        return self._page("Issues & Strengths", content, [("index.html", "Home")])

    def _render_timeline(self) -> str:
        events = self.analysis.wiki.timeline

        rows = []
        for event in events:
            tags = []
            if event.is_flashback:
                tags.append('<span class="tag flashback">flashback</span>')

            chars = ", ".join(event.characters) if event.characters else ""

            rows.append(f"""
<tr>
  <td><strong>{escape(event.when)}</strong> {"".join(tags)}</td>
  <td>{escape(event.description)}</td>
  <td>{escape(event.where)}</td>
  <td>{escape(chars)}</td>
</tr>""")

        content = f"""
<h1>Timeline</h1>

<p class="lead">{len(events)} events in chronological order.</p>

<table>
  <thead>
    <tr><th>When</th><th>Event</th><th>Where</th><th>Characters</th></tr>
  </thead>
  <tbody>
    {"".join(rows)}
  </tbody>
</table>
"""
        return self._page("Timeline", content, [("index.html", "Home")])

    def _render_character(self, char: WikiCharacter) -> str:
        # Infobox
        infobox_rows = []
        if char.aliases:
            infobox_rows.append(f'<div class="infobox-row"><span class="infobox-label">Also known as</span><br>{escape(", ".join(char.aliases))}</div>')
        infobox_rows.append(f'<div class="infobox-row"><span class="infobox-label">Appearances</span><br>{len(char.appearances)} chapters</div>')
        infobox_rows.append(f'<div class="infobox-row"><span class="infobox-label">Relationships</span><br>{len(char.relationships)}</div>')

        infobox = f"""
<div class="infobox">
  <div class="infobox-header">{escape(char.name)}</div>
  {"".join(infobox_rows)}
</div>"""

        # Sections
        sections = []

        if char.description:
            sections.append(f'<p class="lead">{escape(char.description)}</p>')

        toc = ['<li><a href="#profile">Profile</a></li>']

        profile_parts = []
        if char.physical:
            profile_parts.append(f'<p><strong>Physical:</strong> {escape(char.physical)}</p>')
        if char.personality:
            profile_parts.append(f'<p><strong>Personality:</strong> {escape(char.personality)}</p>')
        if char.background:
            profile_parts.append(f'<p><strong>Background:</strong> {escape(char.background)}</p>')

        sections.append(f'<h2 id="profile">Profile</h2>{"".join(profile_parts)}')

        if char.arc:
            toc.append('<li><a href="#arc">Character Arc</a></li>')
            sections.append(f'<h2 id="arc">Character Arc</h2><p>{escape(char.arc)}</p>')

        if char.relationships:
            toc.append('<li><a href="#relationships">Relationships</a></li>')
            rels = []
            for rel in char.relationships:
                rels.append(f'<li><a href="{slugify(rel.target)}.html">{escape(rel.target)}</a> ({escape(rel.relationship)})'
                           f'{" — " + escape(rel.description) if rel.description else ""}</li>')
            sections.append(f'<h2 id="relationships">Relationships</h2><ul>{"".join(rels)}</ul>')

        if char.appearances:
            toc.append('<li><a href="#appearances">Appearances</a></li>')
            rows = []
            for app in char.appearances:
                role_class = app.role
                rows.append(f'<tr><td><a href="../chapters/{slugify(app.chapter_id)}.html">{escape(app.chapter_title)}</a></td>'
                           f'<td><span class="tag {role_class}">{app.role}</span></td>'
                           f'<td>{escape(app.summary)}</td></tr>')
            sections.append(f"""
<h2 id="appearances">Appearances</h2>
<table>
  <thead><tr><th>Chapter</th><th>Role</th><th>Summary</th></tr></thead>
  <tbody>{"".join(rows)}</tbody>
</table>""")

        toc_html = f'<div class="toc"><div class="toc-title">Contents</div><ol>{"".join(toc)}</ol></div>'

        content = f"""
<h1>{escape(char.name)}</h1>
{infobox}
{toc_html}
{"".join(sections)}
"""
        return self._page(char.name, content, [("../index.html", "Home"), ("../index.html#characters", "Characters")])

    def _render_location(self, loc: WikiLocation) -> str:
        infobox_rows = []
        infobox_rows.append(f'<div class="infobox-row"><span class="infobox-label">Scenes</span><br>{len(loc.scenes)}</div>')
        if loc.associated_characters:
            chars = ", ".join(f'<a href="../characters/{slugify(c)}.html">{escape(c)}</a>' for c in loc.associated_characters)
            infobox_rows.append(f'<div class="infobox-row"><span class="infobox-label">Characters</span><br>{chars}</div>')

        infobox = f"""
<div class="infobox">
  <div class="infobox-header">{escape(loc.name)}</div>
  {"".join(infobox_rows)}
</div>"""

        sections = []
        toc = []

        if loc.description:
            sections.append(f'<p class="lead">{escape(loc.description)}</p>')

        if loc.significance:
            toc.append('<li><a href="#significance">Significance</a></li>')
            sections.append(f'<h2 id="significance">Significance</h2><p>{escape(loc.significance)}</p>')

        if loc.scenes:
            toc.append('<li><a href="#scenes">Scenes</a></li>')
            scene_links = [f'<li><a href="../chapters/{slugify(s)}.html">{escape(s)}</a></li>' for s in loc.scenes]
            sections.append(f'<h2 id="scenes">Scenes</h2><ul>{"".join(scene_links)}</ul>')

        # Events at this location
        events_here = [e for e in self.analysis.wiki.timeline
                       if e.where and loc.name.lower() in e.where.lower()]
        if events_here:
            toc.append('<li><a href="#events">Events</a></li>')
            event_items = []
            for ev in events_here:
                tags = ' <span class="tag flashback">flashback</span>' if ev.is_flashback else ''
                event_items.append(f'<li><strong>{escape(ev.when)}</strong>{tags}: {escape(ev.description)}</li>')
            sections.append(f'<h2 id="events">Events</h2><ul>{"".join(event_items)}</ul>')

        toc_html = f'<div class="toc"><div class="toc-title">Contents</div><ol>{"".join(toc)}</ol></div>' if toc else ''

        content = f"""
<h1>{escape(loc.name)}</h1>
{infobox}
{toc_html}
{"".join(sections)}
"""
        return self._page(loc.name, content, [("../index.html", "Home"), ("../index.html#locations", "Locations")])

    def _render_chapter(self, chapter: ChapterInfo) -> str:
        # Find prev/next chapters
        chapters = self.analysis.chapters
        idx = next((i for i, c in enumerate(chapters) if c.id == chapter.id), -1)
        prev_ch = chapters[idx - 1] if idx > 0 else None
        next_ch = chapters[idx + 1] if idx < len(chapters) - 1 else None

        nav_parts = []
        if prev_ch:
            nav_parts.append(f'<a href="{slugify(prev_ch.id)}.html">← {escape(prev_ch.title)}</a>')
        else:
            nav_parts.append('<span></span>')
        if next_ch:
            nav_parts.append(f'<a href="{slugify(next_ch.id)}.html">{escape(next_ch.title)} →</a>')
        else:
            nav_parts.append('<span></span>')
        chapter_nav = f'<div class="chapter-nav">{nav_parts[0]}{nav_parts[1]}</div>'

        # Characters in this chapter
        chars_here = [c for c in self.analysis.wiki.characters
                      if any(a.chapter_id == chapter.id for a in c.appearances)]

        # Events in this chapter
        events_here = [e for e in self.analysis.wiki.timeline if e.chapter_id == chapter.id]

        # Issues mentioning this chapter
        issues_here = [i for i in self.analysis.issues
                       if any(e.chapter_id == chapter.id for e in i.evidence)]

        # Infobox
        infobox = f"""
<div class="infobox">
  <div class="infobox-header">Chapter</div>
  <div class="infobox-row"><span class="infobox-label">Words</span><br>{chapter.word_count:,}</div>
  <div class="infobox-row"><span class="infobox-label">Characters</span><br>{len(chars_here)}</div>
  <div class="infobox-row"><span class="infobox-label">Events</span><br>{len(events_here)}</div>
  {f'<div class="infobox-row"><span class="infobox-label">Issues</span><br><span class="severity-error">{len(issues_here)}</span></div>' if issues_here else ''}
</div>"""

        sections: list[str] = []
        toc: list[str] = []

        # Summary - render markdown to HTML (already has its own ## headers)
        # Preprocess: ensure blank lines before list items and headers for proper markdown parsing
        lines = chapter.summary.split('\n')
        processed_lines: list[str] = []
        for i, line in enumerate(lines):
            # Add blank line before list items or headers if previous line wasn't blank
            if (line.strip().startswith('-') or line.strip().startswith('#')) and i > 0:
                if processed_lines and processed_lines[-1].strip():
                    processed_lines.append('')
            processed_lines.append(line)
        processed_summary = '\n'.join(processed_lines)
        summary_html = markdown.markdown(processed_summary)
        sections.append(summary_html)

        if events_here:
            toc.append('<li><a href="#events">Events</a></li>')
            event_items = []
            for ev in events_here:
                tags = ' <span class="tag flashback">flashback</span>' if ev.is_flashback else ''
                event_items.append(f'<li><strong>{escape(ev.when)}</strong>{tags}: {escape(ev.description)}</li>')
            sections.append(f'<h2 id="events">Events</h2><ul>{"".join(event_items)}</ul>')

        if issues_here:
            toc.append('<li><a href="#issues">Issues</a></li>')
            issue_items = []
            for i in issues_here:
                issue_items.append(f'<li><a href="../issues.html">{"escape(i.title)"}</a> '
                                   f'<span class="severity-{i.severity}">({i.severity})</span></li>')
            sections.append(f'<h2 id="issues">Issues</h2><ul>{"".join(issue_items)}</ul>')

        toc_html = f'<div class="toc"><div class="toc-title">Contents</div><ol>{"".join(toc)}</ol></div>' if toc else ''

        content = f"""
<h1>{escape(chapter.title)}</h1>
{infobox}
{chapter_nav}
{toc_html}
{"".join(sections)}
{chapter_nav}
"""
        return self._page(chapter.title, content, [("../index.html", "Home"), ("../index.html#chapters", "Chapters")])


def generate_wiki(analysis: AnalysisOutput, output_dir: Path) -> None:
    """Generate static wiki from analysis output."""
    generator = WikiGenerator(analysis)
    generator.generate(output_dir)
