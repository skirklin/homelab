#!/usr/bin/env python3
"""
Scan PocketBase for any field still referencing a Firebase ID.

Strategy: load every doc ID and auth UID from the Firebase export, then
walk every record in every PB collection and look for string matches.
Cross-referencing the canonical FB ID set gives zero false positives
(no heuristics like "20-char mixed-case").

Reports each hit grouped by collection / record / field path so we can
follow up with a targeted fix.

Usage (from repo root):
  python3 services/scripts/scan-fb-id-orphans.py
"""
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXPORT_DIR = REPO_ROOT / ".data" / "2026-04-09"

# PocketBase IDs are 15 lowercase alnum chars. Anything longer that's
# mixed-case and alnum is likely Firebase.
PB_ID_RE = re.compile(r"^[a-z0-9]{15}$")

# Firestore document IDs are 20 chars, alphanumeric, mixed-case.
# Firebase auth UIDs are 28 chars, alphanumeric, mixed-case.
# Used to filter out Firebase "IDs" that are actually human-readable strings
# (the old shopping_history collection used ingredient text as the doc id, so
# strings like "broccoli" or "1 lb ground pork" show up as Firebase _ids in
# the export — those aren't real orphan references, they're the same
# ingredient text that legitimately survives in PB).
FB_DOC_ID_RE = re.compile(r"^[A-Za-z0-9]{20}$")
FB_AUTH_UID_RE = re.compile(r"^[A-Za-z0-9]{28}$")


def is_fb_id_shaped(s: str) -> bool:
    return bool(FB_DOC_ID_RE.match(s) or FB_AUTH_UID_RE.match(s))


def load_env():
    env_file = REPO_ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def pb_request(method, path, token=None, body=None, query=None):
    url = f"{PB_URL}{path}"
    if query:
        url += "?" + urllib.parse.urlencode(query, doseq=True)
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            payload = r.read()
            return r.status, (json.loads(payload) if payload else None)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        return e.code, body


def auth_superuser(password):
    code, payload = pb_request(
        "POST",
        "/api/collections/_superusers/auth-with-password",
        body={"identity": "scott.kirklin@gmail.com", "password": password},
    )
    if code != 200 or not isinstance(payload, dict):
        sys.exit(f"superuser auth failed: {code} {payload}")
    return payload["token"]


def list_collections(token):
    code, payload = pb_request("GET", "/api/collections", token=token, query={"perPage": 200})
    if code != 200 or not isinstance(payload, dict):
        sys.exit(f"list collections failed: {code} {payload}")
    return [c["name"] for c in payload.get("items", []) if not c["name"].startswith("_")]


def get_all(token, collection):
    items = []
    page = 1
    while True:
        code, payload = pb_request(
            "GET",
            f"/api/collections/{collection}/records",
            token=token,
            query={"page": page, "perPage": 500},
        )
        if code != 200 or not isinstance(payload, dict):
            print(f"  WARN: list {collection} failed: {code}", file=sys.stderr)
            return items
        items.extend(payload.get("items", []))
        if page >= payload.get("totalPages", 1):
            break
        page += 1
    return items


# ---------------------------------------------------------------------------
# Collect every Firebase ID from the export.
# ---------------------------------------------------------------------------

def collect_fb_ids():
    """Walk every export file, collect every value that looks like an FB id.

    The export shape is:
      - boxes.json:    [ {_id, _sub_recipes: [{_id, ...}], _sub_events: [{_id, ...}]} ]
      - lists.json:    [ {_id, _sub_items, _sub_history, _sub_trips} ]
      - lifeLogs.json: [ {_id, _sub_events} ]
      - taskLists.json:[ {_id, _sub_tasks, _sub_events} ]
      - travelLogs.json:[ {_id, _sub_trips, _sub_activities, _sub_itineraries} ]
      - users.json:    [ {_id, ...} ]
      - _auth_users.json: [ {uid, email, ...} ]
    """
    ids = {}  # id -> list of (source, kind, ctx) tuples telling where it came from

    def add(fb_id, source, kind, ctx=""):
        if not fb_id or not isinstance(fb_id, str):
            return
        # Only keep IDs that are FB-shaped; human-readable Firebase doc IDs
        # like "broccoli" (used as shopping_history _ids) are not orphan
        # references when they show up in PB.
        if not is_fb_id_shaped(fb_id):
            return
        ids.setdefault(fb_id, []).append((source, kind, ctx))

    # auth users
    auth_users = json.loads((EXPORT_DIR / "_auth_users.json").read_text())
    for u in auth_users:
        add(u.get("uid"), "_auth_users.json", "auth_uid", u.get("email", ""))

    # users
    users = json.loads((EXPORT_DIR / "users.json").read_text())
    for u in users:
        add(u.get("_id"), "users.json", "user_id", u.get("email", ""))

    # boxes
    boxes = json.loads((EXPORT_DIR / "boxes.json").read_text())
    for box in boxes:
        bname = (box.get("data") or {}).get("name", "?")
        add(box.get("_id"), "boxes.json", "box_id", bname)
        for r in box.get("_sub_recipes", []):
            rname = (r.get("data") or {}).get("name", "?")
            add(r.get("_id"), "boxes.json", "recipe_id", f"{bname} / {rname}")
        for e in box.get("_sub_events", []):
            add(e.get("_id"), "boxes.json", "recipe_event_id", bname)

    # lists
    lists = json.loads((EXPORT_DIR / "lists.json").read_text())
    for l in lists:
        lname = l.get("name", l.get("_id", "?"))
        add(l.get("_id"), "lists.json", "shopping_list_id", lname)
        for it in l.get("_sub_items", []):
            add(it.get("_id"), "lists.json", "shopping_item_id", lname)
        for h in l.get("_sub_history", []):
            add(h.get("_id"), "lists.json", "shopping_history_id", lname)
        for t in l.get("_sub_trips", []):
            add(t.get("_id"), "lists.json", "shopping_trip_id", lname)

    # lifeLogs
    life = json.loads((EXPORT_DIR / "lifeLogs.json").read_text())
    for log in life:
        lname = log.get("name", log.get("_id", "?"))
        add(log.get("_id"), "lifeLogs.json", "life_log_id", lname)
        for e in log.get("_sub_events", []):
            add(e.get("_id"), "lifeLogs.json", "life_event_id", lname)

    # taskLists
    tasks = json.loads((EXPORT_DIR / "taskLists.json").read_text())
    for tl in tasks:
        tlname = tl.get("name", tl.get("_id", "?"))
        add(tl.get("_id"), "taskLists.json", "task_list_id", tlname)
        for t in tl.get("_sub_tasks", []):
            add(t.get("_id"), "taskLists.json", "task_id", tlname)
        for e in tl.get("_sub_events", []):
            add(e.get("_id"), "taskLists.json", "task_event_id", tlname)

    # travelLogs
    travel = json.loads((EXPORT_DIR / "travelLogs.json").read_text())
    for log in travel:
        lname = log.get("name", log.get("_id", "?"))
        add(log.get("_id"), "travelLogs.json", "travel_log_id", lname)
        for t in log.get("_sub_trips", []):
            add(t.get("_id"), "travelLogs.json", "travel_trip_id", lname)
        for a in log.get("_sub_activities", []):
            add(a.get("_id"), "travelLogs.json", "travel_activity_id", lname)
        for i in log.get("_sub_itineraries", []):
            add(i.get("_id"), "travelLogs.json", "travel_itinerary_id", lname)

    return ids


# ---------------------------------------------------------------------------
# Recursive search: walk a JSON value, yield (json_path, matched_id).
# ---------------------------------------------------------------------------

def walk_strings(value, path="$"):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from walk_strings(v, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from walk_strings(v, f"{path}.{k}")


# ---------------------------------------------------------------------------

def main():
    load_env()
    global PB_URL
    PB_URL = os.environ.get("PB_URL") or "https://api.kirkl.in"
    pw = os.environ.get("PB_ADMIN_PASSWORD")
    if not pw:
        sys.exit("PB_ADMIN_PASSWORD not set")

    print(f"PocketBase: {PB_URL}\n")
    token = auth_superuser(pw)

    print("Loading Firebase ID set from export…")
    fb_ids = collect_fb_ids()
    print(f"  {len(fb_ids)} unique Firebase IDs across {len(set(s for v in fb_ids.values() for s, *_ in v))} export files")

    # Lookup hash: which kind is each id?
    fb_kind = {fid: meta[0][1] for fid, meta in fb_ids.items()}
    fb_ctx = {fid: meta[0][2] for fid, meta in fb_ids.items()}

    print("\nFetching PB collections…")
    collections = list_collections(token)
    print(f"  {len(collections)} user collections")

    # We exclude these by default — they aren't relevant or are too noisy.
    EXCLUDED = {
        "_superusers", "_otps", "_externalAuths", "_authOrigins", "_mfas",
        "oauth_clients", "oauth_codes", "oauth_access_tokens", "oauth_refresh_tokens",
        "api_tokens", "push_subscriptions",
        "pod_events", "deployments",  # monitor-only collections, post-migration data
        # Migration leftovers we already know about, dumped separately for clarity
    }

    findings = []  # list of (collection, record_id, json_path, fb_id, fb_kind, fb_ctx)
    total_hits = 0

    for col in sorted(collections):
        if col in EXCLUDED:
            continue
        items = get_all(token, col)
        col_hits = 0
        for rec in items:
            for path, sval in walk_strings(rec):
                if sval in fb_ids:
                    findings.append((col, rec.get("id"), path, sval, fb_kind[sval], fb_ctx[sval]))
                    col_hits += 1
        if col_hits or items:
            print(f"  {col:24s}  records={len(items):5d}  fb_id_hits={col_hits}")
        total_hits += col_hits

    print(f"\nTotal Firebase-ID hits across PB: {total_hits}\n")

    if not findings:
        print("No stale Firebase IDs found. \U0001f389")
        return

    # Group findings by (collection, field_path) for a readable summary
    print("=" * 70)
    print("Stale Firebase IDs by collection + field path")
    print("=" * 70)
    grouped = {}
    for col, rid, path, fb_id, kind, ctx in findings:
        # Normalize array indices in the path so summary groups cleanly
        norm_path = re.sub(r"\[\d+\]", "[]", path)
        key = (col, norm_path)
        grouped.setdefault(key, []).append((rid, fb_id, kind, ctx))

    for (col, path), rows in sorted(grouped.items()):
        print(f"\n  {col}{path}  — {len(rows)} hit(s)")
        for rid, fb_id, kind, ctx in rows[:10]:
            print(f"    record={rid}  fb_id={fb_id}  kind={kind}  ctx={ctx}")
        if len(rows) > 10:
            print(f"    … and {len(rows)-10} more")

    # Also categorize: how many records are AFFECTED in each collection?
    print("\n" + "=" * 70)
    print("Affected records per collection")
    print("=" * 70)
    by_col_recs = {}
    for col, rid, *_ in findings:
        by_col_recs.setdefault(col, set()).add(rid)
    for col, rids in sorted(by_col_recs.items()):
        print(f"  {col:24s}  {len(rids)} affected records")


if __name__ == "__main__":
    main()
