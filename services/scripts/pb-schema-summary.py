#!/usr/bin/env python3
"""Print a clean per-collection summary of the live PocketBase schema.

Usage:
    pb-schema-summary.py <path-to-pb-data.db>           # all collections
    pb-schema-summary.py <path-to-pb-data.db> <name>    # one collection

Reads the `_collections` system table directly. Used during the Supabase
migration to inventory exactly what PB has today so the SQL translation
doesn't lean on stale migration files.
"""

import json
import sqlite3
import sys
from textwrap import shorten


def field_summary(f: dict) -> str:
    t = f["type"]
    name = f["name"]
    required = " REQ" if f.get("required") else ""
    extra: list[str] = []

    if t == "text":
        mx = f.get("max", 0)
        if mx:
            extra.append(f"max={mx}")
        if f.get("primaryKey"):
            extra.append("PK")
    elif t == "number":
        mn, mx = f.get("min"), f.get("max")
        if mn not in (None, "") or mx not in (None, ""):
            extra.append(f"range=[{mn},{mx}]")
    elif t == "relation":
        cid = f.get("collectionId", "?")
        ms = f.get("maxSelect", "∞")
        casc = " cascade" if f.get("cascadeDelete") else ""
        extra.append(f"→ {cid}, max={ms}{casc}")
    elif t == "json":
        sz = f.get("maxSize", 0)
        if sz:
            extra.append(f"maxSize={sz}")
    elif t == "select":
        vals = f.get("values", [])
        extra.append("vals=[" + ",".join(vals) + "]")
    elif t == "autodate":
        flags = []
        if f.get("onCreate"):
            flags.append("create")
        if f.get("onUpdate"):
            flags.append("update")
        extra.append("on=" + ",".join(flags))

    return f"  {name:24} {t:10}{required}  {' '.join(extra)}".rstrip()


def resolve_relations(fields_by_id: dict, all_collections: dict) -> None:
    """Rewrite relation collectionIds to human-readable names in-place."""
    for f in fields_by_id.values():
        if f["type"] == "relation":
            cid = f.get("collectionId", "")
            f["collectionId"] = all_collections.get(cid, {}).get("name", cid)


def collection_block(row: sqlite3.Row, id_to_name: dict[str, str]) -> str:
    fields = json.loads(row["fields"]) if row["fields"] else []
    # Replace cryptic collectionIds with collection names for readability.
    for f in fields:
        if f.get("type") == "relation":
            cid = f.get("collectionId", "")
            f["collectionId"] = id_to_name.get(cid, cid)

    indexes = json.loads(row["indexes"]) if row["indexes"] else []

    lines = [f"## {row['name']}  ({row['type']})", ""]
    lines.append("Fields:")
    for f in fields:
        lines.append(field_summary(f))
    lines.append("")

    rules = {
        "list": row["listRule"],
        "view": row["viewRule"],
        "create": row["createRule"],
        "update": row["updateRule"],
        "delete": row["deleteRule"],
    }
    lines.append("Rules:")
    for k, v in rules.items():
        if v is None:
            lines.append(f"  {k:6} (admin-only)")
        else:
            lines.append(f"  {k:6} {shorten(v, 200)}")
    lines.append("")

    if indexes:
        lines.append("Indexes:")
        for ix in indexes:
            lines.append(f"  {ix}")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2

    db_path = sys.argv[1]
    only = sys.argv[2] if len(sys.argv) > 2 else None

    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    id_to_name = {
        row["id"]: row["name"]
        for row in con.execute("SELECT id, name FROM _collections")
    }

    query = """
        SELECT id, name, type, listRule, viewRule, createRule, updateRule,
               deleteRule, fields, indexes
        FROM _collections
        WHERE system = 0
    """
    if only:
        query += " AND name = ?"
        rows = con.execute(query + " ORDER BY name", (only,))
    else:
        rows = con.execute(query + " ORDER BY name")

    blocks = [collection_block(r, id_to_name) for r in rows]
    print("\n".join(blocks))
    return 0


if __name__ == "__main__":
    sys.exit(main())
