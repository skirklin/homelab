"""AI-powered rule suggestion engine.

Spawns a Claude Code subprocess to analyze uncategorized transactions and
suggest categorization rules. Suggestions are stored in the database for
human review in the frontend.
"""

import json
import logging
import shutil
import subprocess
from typing import Any

from money.categorize import dry_run_pattern, load_rules
from money.config import CONFIG_DIR
from money.db import Database

log = logging.getLogger(__name__)

RULES_FILE = CONFIG_DIR / "categories.yaml"


def _get_category_tree() -> str:
    """Get the current category hierarchy as a readable string for the prompt."""
    rules = load_rules()
    paths: set[str] = set()
    for rule in rules:
        paths.add(rule.category_path)
    # Build tree display
    lines: list[str] = []
    for path in sorted(paths):
        lines.append(f"  {path}")
    return "\n".join(lines)


def _get_uncategorized_transactions(
    db: Database,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Get uncategorized transactions, grouped by description frequency."""
    rows = db.conn.execute("""
        SELECT t.id, t.description, t.category, t.amount, t.date,
               a.name as account_name, a.institution
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.category_path IS NULL
          AND a.account_type IN ('checking', 'credit_card')
          AND t.id NOT IN (
              SELECT transaction_id FROM suggested_rule_matches srm
              JOIN suggested_rules sr ON srm.rule_id = sr.id
              WHERE sr.status IN ('pending', 'rejected')
          )
        ORDER BY t.date DESC
        LIMIT ?
    """, (limit,)).fetchall()
    return [
        {
            "id": row["id"],
            "description": row["description"],
            "category": row["category"],
            "amount": row["amount"],
            "date": row["date"],
            "account_name": row["account_name"],
            "institution": row["institution"],
        }
        for row in rows
    ]


def _build_prompt(
    transactions: list[dict[str, Any]],
    category_tree: str,
) -> str:
    """Build the prompt for Claude Code subprocess."""
    txn_lines: list[str] = []
    for t in transactions:
        txn_lines.append(
            f"  id={t['id']}  {t['date']}  ${abs(t['amount']):,.2f}  "
            f"{t['description']}  [raw_category: {t['category'] or 'none'}]  "
            f"({t['institution']} / {t['account_name']})"
        )
    txn_block = "\n".join(txn_lines)

    return f"""You are helping categorize personal finance transactions.

Here is the current category hierarchy (materialized paths):
{category_tree}

Here are uncategorized transactions that need rules:
{txn_block}

For each transaction (or group of similar transactions), suggest a categorization rule.
A rule is a SQL LIKE pattern that matches the transaction description, paired with a
category_path from the hierarchy above (or a new path if nothing fits).

Use "category:VALUE" patterns to match the raw_category field instead of description.

Guidelines:
- Prefer patterns that will match future similar transactions, not just the exact description
- Use %MERCHANT_NAME% style patterns — strip location suffixes, transaction IDs, etc.
- If multiple transactions share a merchant, create one rule for all of them
- If you're unsure what a merchant is, search the web to find out
- Confidence should be 0.0-1.0 (1.0 = certain, 0.5 = educated guess)
- Keep reasoning brief (one sentence)

Respond with ONLY a JSON array, no markdown fencing, no other text:
[
  {{
    "pattern": "%MERCHANT_NAME%",
    "category_path": "Category/Subcategory",
    "confidence": 0.9,
    "reasoning": "Brief explanation",
    "transaction_ids": [1, 2, 3]
  }}
]"""


def generate_suggestions(
    db: Database,
    limit: int = 50,
) -> int:
    """Generate rule suggestions for uncategorized transactions.

    Spawns a Claude Code subprocess, parses the response, stores
    suggestions in the database with dry-run matches.

    Returns number of suggestions created.
    """
    claude_path = shutil.which("claude")
    if claude_path is None:
        log.error("Claude CLI not found on PATH")
        return 0

    transactions = _get_uncategorized_transactions(db, limit)
    if not transactions:
        log.info("No uncategorized transactions to suggest rules for.")
        return 0

    log.info("Generating suggestions for %d uncategorized transactions...", len(transactions))

    category_tree = _get_category_tree()
    prompt = _build_prompt(transactions, category_tree)

    try:
        result = subprocess.run(
            [
                claude_path, "--print",
                "--output-format", "json",
                "--model", "sonnet",
                "--allowedTools", "WebSearch", "WebFetch",
                "-p", prompt,
            ],
            capture_output=True,
            text=True,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        log.error("Claude subprocess timed out")
        return 0

    if result.returncode != 0:
        log.error("Claude subprocess failed: %s", result.stderr[:500])
        return 0

    # Parse the JSON output from claude --output-format json
    try:
        output = json.loads(result.stdout)
        # Claude's JSON output format wraps the response
        response_text: str = output.get("result", output.get("text", result.stdout))
    except json.JSONDecodeError:
        response_text = result.stdout

    # Extract the JSON array from the response text
    suggestions = _parse_suggestions(response_text)
    if not suggestions:
        log.warning("No valid suggestions parsed from Claude response")
        return 0

    # Store suggestions and compute dry-run matches
    count = 0
    for suggestion in suggestions:
        pattern = suggestion.get("pattern", "")
        category_path = suggestion.get("category_path", "")
        confidence = suggestion.get("confidence", 0.5)
        reasoning = suggestion.get("reasoning", "")
        transaction_ids: list[int] = suggestion.get("transaction_ids", [])

        if not pattern or not category_path:
            continue

        # Check for duplicate pending suggestions
        existing = db.conn.execute(
            "SELECT id FROM suggested_rules WHERE pattern = ? AND status = 'pending'",
            (pattern,),
        ).fetchone()
        if existing:
            continue

        # Insert the suggestion
        cursor = db.conn.execute(
            """INSERT INTO suggested_rules (pattern, category_path, confidence, reasoning)
               VALUES (?, ?, ?, ?)""",
            (pattern, category_path, confidence, reasoning),
        )
        rule_id = cursor.lastrowid
        assert rule_id is not None

        # Compute dry-run matches: all transactions this pattern would affect
        matches = dry_run_pattern(db, pattern, category_path)
        match_ids = [m["id"] for m in matches]

        # Also include the explicitly referenced transaction_ids
        all_ids = set(match_ids) | set(transaction_ids)

        if all_ids:
            db.conn.executemany(
                "INSERT OR IGNORE INTO suggested_rule_matches (rule_id, transaction_id) "
                "VALUES (?, ?)",
                [(rule_id, tid) for tid in all_ids],
            )

        count += 1
        log.info(
            "  Suggestion: %s → %s (%d matches, confidence %.1f)",
            pattern, category_path, len(all_ids), confidence,
        )

    db.conn.commit()
    log.info("Created %d suggestions.", count)
    return count


def _parse_suggestions(text: str) -> list[dict[str, Any]]:
    """Extract JSON array of suggestions from Claude's response text."""
    # Try parsing the whole thing as JSON first
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return list(parsed)
    except json.JSONDecodeError:
        pass

    # Try to find a JSON array in the text
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, list):
                return list(parsed)
        except json.JSONDecodeError:
            pass

    return []


def accept_suggestion(db: Database, rule_id: int) -> int:
    """Accept a suggestion: append rule to YAML and apply it.

    Returns number of transactions categorized.
    """
    row = db.conn.execute(
        "SELECT pattern, category_path FROM suggested_rules WHERE id = ?",
        (rule_id,),
    ).fetchone()
    if row is None:
        return 0

    pattern: str = row["pattern"]
    category_path: str = row["category_path"]

    # Append to categories.yaml
    _append_rule_to_yaml(pattern, category_path)

    # Apply the rule to matching transactions
    from money.categorize import apply_rules

    count = apply_rules(db)

    # Mark as accepted
    db.conn.execute(
        "UPDATE suggested_rules SET status = 'accepted' WHERE id = ?",
        (rule_id,),
    )
    db.conn.commit()

    return count


def reject_suggestion(db: Database, rule_id: int) -> None:
    """Reject a suggestion so it won't be re-suggested."""
    db.conn.execute(
        "UPDATE suggested_rules SET status = 'rejected' WHERE id = ?",
        (rule_id,),
    )
    db.conn.commit()


def _append_rule_to_yaml(pattern: str, category_path: str) -> None:
    """Append a rule to the categories.yaml file under the correct path."""
    import yaml  # type: ignore[import-untyped]

    if not RULES_FILE.exists():
        log.error("Categories file not found: %s", RULES_FILE)
        return

    config: dict[str, Any] = yaml.safe_load(RULES_FILE.read_text())
    rules_tree: dict[str, Any] = config.get("rules", {})

    # Navigate/create the path in the tree
    segments = category_path.split("/")
    node = rules_tree
    for seg in segments[:-1]:
        if seg not in node:
            node[seg] = {}
        child = node[seg]
        if isinstance(child, list):
            # This level currently has direct patterns; convert to dict
            node[seg] = {"_patterns": child}
            child = node[seg]
        node = child

    # Add pattern to the leaf
    leaf_key = segments[-1]
    if leaf_key not in node:
        node[leaf_key] = []
    leaf = node[leaf_key]
    if isinstance(leaf, list):
        if pattern not in leaf:
            leaf.append(pattern)
    elif isinstance(leaf, dict):
        # Leaf is a dict (has subcategories); add to a direct patterns list
        if "_patterns" not in leaf:
            leaf["_patterns"] = []
        patterns_list: list[str] = leaf["_patterns"]
        if pattern not in patterns_list:
            patterns_list.append(pattern)

    config["rules"] = rules_tree
    RULES_FILE.write_text(yaml.dump(config, default_flow_style=False, sort_keys=False))
    log.info("Appended rule to %s: %s → %s", RULES_FILE, pattern, category_path)


def get_pending_suggestions(db: Database) -> list[dict[str, Any]]:
    """Get all pending suggestions with their matched transactions."""
    rules = db.conn.execute("""
        SELECT sr.id, sr.pattern, sr.category_path, sr.confidence,
               sr.reasoning, sr.created_at
        FROM suggested_rules sr
        WHERE sr.status = 'pending'
        ORDER BY sr.confidence DESC, sr.created_at DESC
    """).fetchall()

    result: list[dict[str, Any]] = []
    for rule in rules:
        matches = db.conn.execute("""
            SELECT t.id, t.date, t.amount, t.description, t.category,
                   t.category_path, a.name as account_name, a.institution
            FROM suggested_rule_matches srm
            JOIN transactions t ON srm.transaction_id = t.id
            JOIN accounts a ON t.account_id = a.id
            WHERE srm.rule_id = ?
            ORDER BY t.date DESC
        """, (rule["id"],)).fetchall()

        result.append({
            "id": rule["id"],
            "pattern": rule["pattern"],
            "category_path": rule["category_path"],
            "confidence": rule["confidence"],
            "reasoning": rule["reasoning"],
            "created_at": rule["created_at"],
            "matches": [
                {
                    "id": m["id"],
                    "date": m["date"],
                    "amount": m["amount"],
                    "description": m["description"],
                    "category": m["category"],
                    "current_category_path": m["category_path"],
                    "account_name": m["account_name"],
                    "institution": m["institution"],
                }
                for m in matches
            ],
        })

    return result
