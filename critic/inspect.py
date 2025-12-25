#!/usr/bin/env python3
"""Inspect analysis outputs and cache for debugging."""

import json
from pathlib import Path

import click


@click.group()
def main():
    """Inspect analysis outputs and cache."""
    pass


@main.command()
@click.argument("analysis_json", type=click.Path(exists=True))
@click.option("--character", "-c", help="Filter by character name")
def characters(analysis_json, character):
    """Show character profiles from an analysis."""
    data = json.loads(Path(analysis_json).read_text())

    for char in data["entities"]["characters"]:
        if character and character.lower() not in char["name"].lower():
            continue

        print(f"=== {char['name']} ({char['id']}) ===")
        print(f"Aliases: {char['aliases']}")
        print(f"Stats: {char['stats']['totalMentions']} mentions, {char['stats']['presentInChunks']} chunks")
        print()

        profile = char["profile"]
        print("Profile:")
        print(f"  Physical: {profile['physical']}")
        print(f"  Personality: {profile['personality']}")
        print(f"  Occupation: {profile['occupation']}")
        print(f"  Relationships: {profile['keyRelationships']}")
        print()

        if char["attributes"]:
            print(f"Attributes ({len(char['attributes'])} total):")
            for attr in char["attributes"][:10]:
                print(f"  - [{attr['category']}] {attr['value']}")
            if len(char["attributes"]) > 10:
                print(f"  ... and {len(char['attributes']) - 10} more")
        print()


@main.command()
@click.argument("analysis_json", type=click.Path(exists=True))
@click.option("--chunk", "-c", help="Filter by chunk ID")
def extractions(analysis_json, chunk):
    """Show extraction summaries from an analysis."""
    data = json.loads(Path(analysis_json).read_text())

    for c in data["chunks"]:
        if chunk and chunk != c["id"]:
            continue

        ext = c["extraction"]
        print(f"=== {c['id']}: {c['title'] or '(untitled)'} ===")
        print(f"  Events: {len(ext['events'])}")
        print(f"  Characters: {len(ext['characterMentions'])}")
        print(f"  Facts: {len(ext['facts'])}")
        print(f"  Plot threads: {len(ext['plotThreads'])}")
        print(f"  Setups: {len(ext['setups'])}")
        print(f"  Dialogue: {len(ext['dialogue'])}")
        print()

        if ext["characterMentions"]:
            print("  Character mentions:")
            for cm in ext["characterMentions"][:5]:
                attrs = cm.get("attributesMentioned", [])
                attr_summary = ""
                if attrs:
                    if isinstance(attrs[0], dict):
                        attr_summary = f" [{', '.join(a.get('value', str(a)) for a in attrs[:3])}]"
                    else:
                        attr_summary = f" [{', '.join(str(a) for a in attrs[:3])}]"
                print(f"    - {cm['name']} ({cm['role']}){attr_summary}")
        print()


@main.command()
@click.option("--cache-dir", default=".book-editor-cache", help="Cache directory")
def cache(cache_dir):
    """Show cache contents and format."""
    cache_path = Path(cache_dir)

    if not cache_path.exists():
        print("No cache directory found")
        return

    for subdir in ["chunks", "discovery", "extraction"]:
        subpath = cache_path / subdir
        if not subpath.exists():
            continue

        files = list(subpath.glob("*.json"))
        total_size = sum(f.stat().st_size for f in files)
        print(f"{subdir}: {len(files)} files ({total_size / 1024:.1f} KB)")

    # Sample extraction to show format
    extraction_dir = cache_path / "extraction"
    if extraction_dir.exists():
        files = list(extraction_dir.glob("*.json"))
        for f in files[:3]:
            data = json.loads(f.read_text())
            ext = data.get("extraction", {})
            chars = ext.get("character_mentions", [])

            print(f"\nSample: {f.name}")
            print(f"  Characters: {len(chars)}")

            if chars:
                attrs = chars[0].get("attributes_mentioned", [])
                if attrs:
                    first = attrs[0]
                    if isinstance(first, dict):
                        print(f"  Attr format: dict with keys {list(first.keys())}")
                    else:
                        print(f"  Attr format: {type(first).__name__}")
                    print(f"  Sample attr: {first}")


@main.command()
@click.argument("analysis_json", type=click.Path(exists=True))
@click.option("--entity", "-e", help="Filter by entity name")
def timeline(analysis_json, entity):
    """Show timeline from an analysis."""
    data = json.loads(Path(analysis_json).read_text())
    tl = data["timeline"]

    print(f"Anchor: {tl['anchorPoint']}")
    print(f"Global events: {len(tl['globalEvents'])}")
    print(f"Entity timelines: {len(tl['entityTimelines'])}")
    print()

    for et in tl["entityTimelines"]:
        if entity and entity.lower() not in et["entityName"].lower():
            continue

        print(f"=== {et['entityName']} ({et['entityType']}) ===")
        print(f"Events: {len(et['events'])}")
        for evt in et["events"][:5]:
            print(f"  [{evt['normalizedTime']}] {evt['description'][:60]}...")
        if len(et["events"]) > 5:
            print(f"  ... and {len(et['events']) - 5} more")
        print()


if __name__ == "__main__":
    main()
