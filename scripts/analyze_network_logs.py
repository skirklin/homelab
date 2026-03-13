"""Analyze captured network logs to discover API routes and data shapes."""

import json
import sys
from pathlib import Path

SKIP_DOMAINS = [
    "launchdarkly", "google", "segment", "dynatrace", "sentry", "qualtrics",
    "lgrckt", "newrelic", "facebook", "doubleclick", "optimizely", "mixpanel",
    "datadoghq", "outbrain", "braze", "appsflyer", "branch", "cookielaw",
    "demdex", "cdn-settings", "akamai", "nr-data", "userevents",
    "tte-prod.telemetry", "ekr.zdassets",
]


def analyze(path: Path, show_bodies: bool = False) -> None:
    data = json.loads(path.read_text())
    entries = data["entries"]
    institution = data.get("institution", path.stem)

    print(f"\n{'=' * 60}")
    print(f"  {institution.upper()} — {len(entries)} total entries")
    print(f"{'=' * 60}\n")

    seen: set[str] = set()
    interesting: list[dict] = []

    for e in entries:
        url: str = e.get("url", "")
        if any(x in url.lower() for x in SKIP_DOMAINS):
            continue

        base = url.split("?")[0]
        method: str = e.get("method", "")
        key = f"{method} {base}"
        if key in seen:
            continue
        seen.add(key)

        status = e.get("status", 0)
        size = e.get("responseSize") or 0
        ct: str = e.get("contentType", "")

        # Only show JSON API responses
        if not ("json" in ct or "/api/" in url or "/graphql" in url or "/capitan/" in url):
            continue

        print(f"  {method:6s} {status:3d}  {size:>8,d} bytes  {base}")
        interesting.append(e)

    if show_bodies:
        print(f"\n{'─' * 60}")
        print("  Response bodies for interesting endpoints:")
        print(f"{'─' * 60}\n")

        for e in interesting:
            body = e.get("responseBody")
            if not body:
                continue
            url = e["url"].split("?")[0]
            method = e.get("method", "")
            req_body = e.get("requestBody")

            print(f"  >>> {method} {url}")
            if req_body:
                print(f"  Request: {req_body[:200]}")
            preview = json.dumps(body, indent=2)
            # Show first 800 chars
            for line in preview[:800].splitlines():
                print(f"    {line}")
            if len(preview) > 800:
                print(f"    ... ({len(preview):,d} total chars)")
            print()


def main() -> None:
    log_dir = Path(".data/network_logs")

    if len(sys.argv) > 1:
        # Analyze specific file
        analyze(Path(sys.argv[1]), show_bodies=True)
        return

    # Analyze all, most recent per institution
    by_institution: dict[str, Path] = {}
    for f in sorted(log_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        inst = f.stem.rsplit("_", 2)[0]
        if inst not in by_institution:
            by_institution[inst] = f

    for inst, path in sorted(by_institution.items()):
        analyze(path, show_bodies=True)


if __name__ == "__main__":
    main()
