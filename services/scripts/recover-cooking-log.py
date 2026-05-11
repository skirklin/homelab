#!/usr/bin/env python3
"""
Recover the 35 cooking-log events that were broken by migrate-firebase.ts.

The original migration wrote each `recipe_events` row with the Firebase recipe
ID as `subject_id` (no FB->PB recipe map existed) and used `new Date()` for the
timestamp (eData.timestamp was never passed through). The notes (eData.data)
were also dropped. The `box` link survived because the box map was built.

This script reads the static Firebase export at
.data/2026-04-09/boxes.json + _auth_users.json, maps Firebase IDs to current
PocketBase IDs by name/email, and rewrites the events.

Usage (from repo root):
  python3 services/scripts/recover-cooking-log.py              # dry run
  python3 services/scripts/recover-cooking-log.py --apply       # do it

Both .env vars PB_ADMIN_PASSWORD and PB_URL (default https://api.kirkl.in)
are honoured.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
EXPORT_DIR = REPO_ROOT / ".data" / "2026-04-09"


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
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = token
    if body is not None:
        data = json.dumps(body).encode()
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


def get_all(token, collection, **query):
    items = []
    page = 1
    while True:
        q = {"page": page, "perPage": 200, **query}
        code, payload = pb_request("GET", f"/api/collections/{collection}/records", token=token, query=q)
        if code != 200 or not isinstance(payload, dict):
            sys.exit(f"list {collection} failed: {code} {payload}")
        items.extend(payload.get("items", []))
        if page >= payload.get("totalPages", 1):
            break
        page += 1
    return items


# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true", help="Apply changes (default is dry-run)")
    p.add_argument(
        "--rename",
        action="append",
        default=[],
        metavar="FB_ID=PB_ID",
        help="Explicit Firebase recipe id -> PocketBase recipe id override, "
             "for recipes that were renamed during the migration so the "
             "name-based lookup misses them. Repeatable.",
    )
    args = p.parse_args()

    # Parse renames into a dict.
    rename_map = {}
    for r in args.rename:
        if "=" not in r:
            sys.exit(f"--rename value must be FB_ID=PB_ID, got {r!r}")
        fb, pb = r.split("=", 1)
        rename_map[fb.strip()] = pb.strip()

    load_env()
    global PB_URL
    PB_URL = os.environ.get("PB_URL") or "https://api.kirkl.in"
    pw = os.environ.get("PB_ADMIN_PASSWORD")
    if not pw:
        sys.exit("PB_ADMIN_PASSWORD not set")

    print(f"PocketBase: {PB_URL}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}")
    print()

    token = auth_superuser(pw)

    # --- Load Firebase export ----------------------------------------------
    fb_boxes = json.loads((EXPORT_DIR / "boxes.json").read_text())
    fb_users = json.loads((EXPORT_DIR / "_auth_users.json").read_text())

    # FB uid -> email
    fb_uid_to_email = {u["uid"]: u.get("email") for u in fb_users if u.get("email")}

    # FB box_id -> { name, events, recipes_by_name -> fb_recipe_id }
    fb_box_meta = {}
    fb_event_count = 0
    for box in fb_boxes:
        fb_box_id = box["_id"]
        name = (box.get("data") or {}).get("name")
        recipes_by_name = {}
        for r in box.get("_sub_recipes", []):
            rname = (r.get("data") or {}).get("name") or ""
            if rname:
                recipes_by_name.setdefault(rname.strip(), []).append(r["_id"])
        events = list(box.get("_sub_events", []))
        fb_event_count += len(events)
        fb_box_meta[fb_box_id] = {"name": name, "events": events, "recipes_by_name": recipes_by_name}

    # FB recipe_id -> recipe name (within its box)
    fb_recipe_name = {}
    for box in fb_boxes:
        for r in box.get("_sub_recipes", []):
            fb_recipe_name[r["_id"]] = (r.get("data") or {}).get("name") or ""

    print(f"Loaded export: {len(fb_boxes)} boxes, {fb_event_count} cooking-log events")

    # --- Fetch current PB data --------------------------------------------
    pb_boxes = get_all(token, "recipe_boxes")
    pb_recipes = get_all(token, "recipes")
    pb_users = get_all(token, "users")
    pb_events = get_all(token, "recipe_events")
    print(f"Current PB: {len(pb_boxes)} boxes, {len(pb_recipes)} recipes, "
          f"{len(pb_users)} users, {len(pb_events)} recipe_events")
    print()

    # Build PB box-name -> id
    pb_box_by_name = {}
    pb_box_id_to_name = {}
    for b in pb_boxes:
        nm = (b.get("name") or "").strip()
        if nm:
            pb_box_by_name.setdefault(nm, []).append(b["id"])
        pb_box_id_to_name[b["id"]] = nm

    # Build PB recipes: (pb_box_id, name) -> pb_recipe_id
    pb_recipe_by_box_name = {}
    for r in pb_recipes:
        nm = ((r.get("data") or {}).get("name") or "").strip()
        if nm:
            key = (r["box"], nm)
            pb_recipe_by_box_name.setdefault(key, []).append(r["id"])

    # Build user email -> pb id
    pb_user_by_email = {}
    for u in pb_users:
        if u.get("email"):
            pb_user_by_email[u["email"].lower()] = u["id"]

    # --- Build mappings ----------------------------------------------------
    fb_box_to_pb_box = {}
    for fb_id, meta in fb_box_meta.items():
        name = (meta.get("name") or "").strip()
        if not name:
            continue
        matches = pb_box_by_name.get(name) or []
        if len(matches) == 1:
            fb_box_to_pb_box[fb_id] = matches[0]
        elif len(matches) > 1:
            print(f"  WARN: FB box '{name}' has {len(matches)} PB matches; skipping")

    # --- Walk FB events, plan rewrites ------------------------------------
    plans = []  # list of dicts: {fb_event_id, pb_box, pb_recipe, pb_user, timestamp, notes, fb_recipe_id}
    skipped = []
    for fb_box_id, meta in fb_box_meta.items():
        pb_box_id = fb_box_to_pb_box.get(fb_box_id)
        for ev in meta["events"]:
            fb_subj = ev.get("subjectId") or ""
            fb_user = ev.get("createdBy") or ""
            ts = (ev.get("timestamp") or {}).get("value") if isinstance(ev.get("timestamp"), dict) else ev.get("timestamp")
            notes = (ev.get("data") or {}).get("notes")

            r_name = fb_recipe_name.get(fb_subj, "").strip()

            problem = None
            pb_recipe_id = None
            # Explicit overrides win — used when a recipe was renamed during
            # the FB->PB migration so name-based lookup can't find it.
            override = rename_map.get(fb_subj)
            if override:
                if override in {r["id"] for r in pb_recipes}:
                    pb_recipe_id = override
                else:
                    problem = f"--rename target {override} does not exist in PB recipes"
            elif not pb_box_id:
                problem = f"box not mapped (fb_box={fb_box_id})"
            elif not r_name:
                problem = f"FB recipe {fb_subj} not in export"
            else:
                matches = pb_recipe_by_box_name.get((pb_box_id, r_name), [])
                if len(matches) == 1:
                    pb_recipe_id = matches[0]
                elif len(matches) > 1:
                    problem = f"recipe name '{r_name}' matches {len(matches)} PB recipes in box"
                else:
                    problem = f"recipe '{r_name}' (fb {fb_subj}) not found in PB box {pb_box_id}"

            email = fb_uid_to_email.get(fb_user, "").lower()
            pb_user_id = pb_user_by_email.get(email)
            if not pb_user_id and not problem:
                problem = f"user {fb_user} ({email}) not in PB"

            if problem:
                skipped.append({"fb_event": ev["_id"], "fb_recipe_id": fb_subj,
                                "recipe_name": r_name, "problem": problem})
                continue

            plans.append({
                "fb_event_id": ev["_id"],
                "pb_box": pb_box_id,
                "pb_recipe": pb_recipe_id,
                "pb_user": pb_user_id,
                "timestamp": ts,
                "notes": notes,
                "recipe_name": r_name,
                "fb_subj": fb_subj,
            })

    # Orphan PB events to delete
    pb_recipe_ids = {r["id"] for r in pb_recipes}
    orphan_pb_events = [e for e in pb_events if e.get("subject_id") not in pb_recipe_ids]

    print(f"Planned rewrites: {len(plans)}")
    print(f"Skipped (unmapped): {len(skipped)}")
    print(f"Orphan PB events to delete: {len(orphan_pb_events)}")
    print()

    if skipped:
        print("Unmapped events (will be lost):")
        for s in skipped:
            print(f"  - fb_event={s['fb_event']}  recipe={s['recipe_name']!r}  reason: {s['problem']}")
        print()

    # Group plans by recipe for readable preview
    print("Plan preview (by recipe):")
    by_recipe = {}
    for pl in plans:
        by_recipe.setdefault((pl["pb_recipe"], pl["recipe_name"]), []).append(pl)
    for (rid, rname), evs in sorted(by_recipe.items(), key=lambda x: x[0][1]):
        print(f"  {rname}  -> {rid}  ({len(evs)} entries)")
        for pl in sorted(evs, key=lambda p: p["timestamp"] or ""):
            note_preview = (pl["notes"] or "")[:80]
            print(f"     ts={pl['timestamp']}  notes={note_preview!r}")
    print()

    if not args.apply:
        print("Dry-run complete. Re-run with --apply to perform the rewrite.")
        return

    # --- Apply -------------------------------------------------------------
    print("Applying changes...")

    # 1) Delete all orphan PB events
    deleted = 0
    for ev in orphan_pb_events:
        code, payload = pb_request("DELETE", f"/api/collections/recipe_events/records/{ev['id']}", token=token)
        if code in (200, 204):
            deleted += 1
        else:
            print(f"  delete {ev['id']} failed: {code} {payload}")
    print(f"  Deleted {deleted}/{len(orphan_pb_events)} orphan events.")

    # 2) Create rewritten events
    created = 0
    for pl in plans:
        body = {
            "box": pl["pb_box"],
            "subject_id": pl["pb_recipe"],
            "timestamp": pl["timestamp"],
            "created_by": pl["pb_user"],
            "data": {"notes": pl["notes"]} if pl["notes"] else {},
        }
        code, payload = pb_request("POST", "/api/collections/recipe_events/records", token=token, body=body)
        if code in (200, 201):
            created += 1
        else:
            print(f"  create event for recipe={pl['recipe_name']!r} ts={pl['timestamp']} failed: {code} {payload}")
    print(f"  Created {created}/{len(plans)} events.")

    # --- Verify ------------------------------------------------------------
    print()
    print("Verification:")
    pb_events_after = get_all(token, "recipe_events")
    print(f"  recipe_events totalItems after: {len(pb_events_after)}")
    orphan_after = [e for e in pb_events_after if e.get("subject_id") not in pb_recipe_ids]
    print(f"  orphan after: {len(orphan_after)}")


if __name__ == "__main__":
    main()
