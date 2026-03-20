"""AI-powered rule suggestion engine.

Spawns a Claude Code subprocess to analyze transactions and suggest
categorization rules. Suggestions include a YAML patch that can be
applied directly to categories.yaml on acceptance.
"""

import json
import logging
import shutil
import subprocess
from typing import Any

from money.categorize import apply_rules, dry_run_pattern, load_rules
from money.config import CONFIG_DIR
from money.db import Database

log = logging.getLogger(__name__)

RULES_FILE = CONFIG_DIR / "categories.yaml"


def _get_category_tree() -> str:
    """Get the current category hierarchy as a readable string."""
    rules = load_rules()
    paths: set[str] = set()
    for rule in rules:
        paths.add(rule.category_path)
    return "\n".join(f"  {p}" for p in sorted(paths))


def _get_yaml_content() -> str:
    """Read the raw YAML file content."""
    if not RULES_FILE.exists():
        return ""
    return RULES_FILE.read_text()


def _get_rejected_feedback(db: Database) -> str:
    """Get feedback from rejected suggestions to include in the prompt."""
    rows = db.conn.execute("""
        SELECT pattern, category_path, feedback
        FROM suggested_rules
        WHERE status = 'rejected' AND feedback IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 20
    """).fetchall()
    if not rows:
        return ""
    lines = ["Previously rejected suggestions (learn from these):"]
    for row in rows:
        lines.append(
            f"  {row['pattern']} → {row['category_path']} — REJECTED: {row['feedback']}"
        )
    return "\n".join(lines)


def _get_uncategorized_transactions(
    db: Database,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Get uncategorized transactions not already covered by pending suggestions."""
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


def _format_transactions(transactions: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for t in transactions:
        lines.append(
            f"  id={t['id']}  {t['date']}  ${abs(t['amount']):,.2f}  "
            f"{t['description']}  [raw_category: {t['category'] or 'none'}]  "
            f"({t['institution']} / {t['account_name']})"
        )
    return "\n".join(lines)


_PATCH_INSTRUCTIONS = """
Your response must be a JSON array. Each element has:
- "yaml_patch": a unified diff to apply to categories.yaml. Use standard
  unified diff format (--- a/categories.yaml, +++ b/categories.yaml, @@ lines).
  The patch should add patterns under the correct category path, and remove
  them from any wrong location if this is a reclassification.
- "category_path": the target category path (e.g. "recurring/gym")
- "pattern": the SQL LIKE pattern being added
- "confidence": 0.0-1.0
- "reasoning": one sentence explanation
- "transaction_ids": list of transaction IDs this rule would match

Keep patches minimal — only add/remove the specific pattern lines needed.
Do NOT rewrite the whole file.

Respond with ONLY the JSON array, no markdown fencing, no other text.
"""


def _run_claude(prompt: str) -> str | None:
    """Run a Claude Code subprocess and return the response text."""
    claude_path = shutil.which("claude")
    if claude_path is None:
        log.error("Claude CLI not found on PATH")
        return None

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
        return None

    if result.returncode != 0:
        log.error("Claude subprocess failed: %s", result.stderr[:500])
        return None

    try:
        output = json.loads(result.stdout)
        return str(output.get("result", output.get("text", result.stdout)))
    except json.JSONDecodeError:
        return result.stdout


def _parse_suggestions(text: str) -> list[dict[str, Any]]:
    """Extract JSON array of suggestions from Claude's response text."""
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return list(parsed)
    except json.JSONDecodeError:
        pass

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


def _store_suggestions(
    db: Database,
    suggestions: list[dict[str, Any]],
    context: str = "",
) -> int:
    """Store parsed suggestions in the database. Returns count stored."""
    count = 0
    for suggestion in suggestions:
        pattern = suggestion.get("pattern", "")
        category_path = suggestion.get("category_path", "")
        confidence = suggestion.get("confidence", 0.5)
        reasoning = suggestion.get("reasoning", "")
        yaml_patch = suggestion.get("yaml_patch", "")
        transaction_ids: list[int] = suggestion.get("transaction_ids", [])

        if not pattern or not category_path:
            continue

        existing = db.conn.execute(
            "SELECT id FROM suggested_rules WHERE pattern = ? AND status = 'pending'",
            (pattern,),
        ).fetchone()
        if existing:
            continue

        full_reasoning = f"[{context}] {reasoning}" if context else reasoning

        cursor = db.conn.execute(
            """INSERT INTO suggested_rules
               (pattern, category_path, confidence, reasoning, yaml_patch)
               VALUES (?, ?, ?, ?, ?)""",
            (pattern, category_path, confidence, full_reasoning, yaml_patch or None),
        )
        rule_id = cursor.lastrowid
        assert rule_id is not None

        matches = dry_run_pattern(db, pattern, category_path)
        match_ids = [m["id"] for m in matches]
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
    return count


def generate_suggestions(db: Database, limit: int = 50) -> int:
    """Generate rule suggestions for uncategorized transactions."""
    transactions = _get_uncategorized_transactions(db, limit)
    if not transactions:
        log.info("No uncategorized transactions to suggest rules for.")
        return 0

    log.info("Generating suggestions for %d uncategorized transactions...", len(transactions))

    yaml_content = _get_yaml_content()
    rejected_feedback = _get_rejected_feedback(db)
    rejected_section = f"\n\n{rejected_feedback}" if rejected_feedback else ""

    prompt = f"""You are helping categorize personal finance transactions.

Here is the current categories.yaml file:
```yaml
{yaml_content}
```
{rejected_section}

Here are uncategorized transactions that need rules:
{_format_transactions(transactions)}

For each transaction (or group of similar transactions), suggest a rule.
If you're unsure what a merchant is, search the web to find out.
{_PATCH_INSTRUCTIONS}"""

    response = _run_claude(prompt)
    if not response:
        return 0

    suggestions = _parse_suggestions(response)
    if not suggestions:
        log.warning("No valid suggestions parsed from Claude response")
        return 0

    count = _store_suggestions(db, suggestions)
    log.info("Created %d suggestions.", count)
    return count


def reclassify_transaction(db: Database, transaction_id: int, feedback: str) -> int:
    """Generate a reclassification suggestion for a single transaction."""
    row = db.conn.execute("""
        SELECT t.id, t.description, t.category, t.category_path, t.amount, t.date,
               a.name as account_name, a.institution
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE t.id = ?
    """, (transaction_id,)).fetchone()

    if not row:
        log.error("Transaction %d not found", transaction_id)
        return 0

    description = row["description"] or ""
    current_path = row["category_path"] or "uncategorized"

    log.info(
        "Reclassifying transaction %d '%s' (currently %s, feedback: %s)",
        transaction_id, description, current_path, feedback,
    )

    yaml_content = _get_yaml_content()

    txn_info = (
        f"id={row['id']}  {row['date']}  ${abs(row['amount']):,.2f}  {description}"
        f"  [raw_category: {row['category'] or 'none'}]"
        f"  ({row['institution']} / {row['account_name']})"
    )

    prompt = f"""You are helping reclassify a personal finance transaction.

This transaction is currently categorized as "{current_path}" but the user
says this is wrong. Their feedback: "{feedback}"

Transaction:
  {txn_info}

Here is the current categories.yaml file:
```yaml
{yaml_content}
```

Produce a patch to categories.yaml that:
1. Removes the pattern from its current wrong location (if applicable)
2. Adds it under the correct category

If you're unsure what the merchant is, search the web to find out.
The user's feedback should guide your classification.
{_PATCH_INSTRUCTIONS}"""

    response = _run_claude(prompt)
    if not response:
        return 0

    suggestions = _parse_suggestions(response)
    if not suggestions:
        log.warning("No valid suggestions parsed from Claude response")
        return 0

    count = _store_suggestions(db, suggestions, f"reclassify from {current_path}")
    log.info("Created %d reclassification suggestions.", count)
    return count


def accept_suggestion(db: Database, rule_id: int) -> int:
    """Accept a suggestion: apply YAML patch and re-categorize.

    Returns number of transactions categorized.
    """
    row = db.conn.execute(
        "SELECT pattern, category_path, yaml_patch FROM suggested_rules WHERE id = ?",
        (rule_id,),
    ).fetchone()
    if row is None:
        return 0

    yaml_patch: str | None = row["yaml_patch"]

    # Apply the YAML patch if provided
    if yaml_patch and RULES_FILE.exists():
        _apply_yaml_patch(yaml_patch)

    # Re-apply all rules from the updated YAML
    count = apply_rules(db)

    db.conn.execute(
        "UPDATE suggested_rules SET status = 'accepted' WHERE id = ?",
        (rule_id,),
    )
    db.conn.commit()

    return count


def _apply_yaml_patch(patch: str) -> None:
    """Apply a unified diff patch to categories.yaml."""
    import tempfile

    original = RULES_FILE.read_text()

    # Write original and patch to temp files, then use `patch` command
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as orig_f:
        orig_f.write(original)
        orig_path = orig_f.name

    with tempfile.NamedTemporaryFile(mode="w", suffix=".patch", delete=False) as patch_f:
        patch_f.write(patch)
        patch_path = patch_f.name

    try:
        result = subprocess.run(
            ["patch", "--fuzz=3", "-o", "-", orig_path, patch_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            RULES_FILE.write_text(result.stdout)
            log.info("Applied YAML patch successfully")
        else:
            log.warning(
                "Patch failed (rc=%d), falling back to direct append: %s",
                result.returncode, result.stderr[:200],
            )
            # Fallback: if patch fails, just append the new lines
            _fallback_append(patch, original)
    finally:
        import os
        os.unlink(orig_path)
        os.unlink(patch_path)


def _fallback_append(patch: str, original: str) -> None:
    """If the unified diff fails to apply, extract added lines and append them."""
    added_lines = []
    for line in patch.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added_lines.append(line[1:])

    if added_lines:
        content = original.rstrip("\n") + "\n" + "\n".join(added_lines) + "\n"
        RULES_FILE.write_text(content)
        log.info("Fallback: appended %d lines to YAML", len(added_lines))


def reject_suggestion(db: Database, rule_id: int, feedback: str | None = None) -> None:
    """Reject a suggestion so it won't be re-suggested."""
    db.conn.execute(
        "UPDATE suggested_rules SET status = 'rejected', feedback = ? WHERE id = ?",
        (feedback, rule_id),
    )
    db.conn.commit()


def get_pending_suggestions(db: Database) -> list[dict[str, Any]]:
    """Get all pending suggestions with their matched transactions."""
    rules = db.conn.execute("""
        SELECT sr.id, sr.pattern, sr.category_path, sr.confidence,
               sr.reasoning, sr.yaml_patch, sr.created_at
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
            "yaml_patch": rule["yaml_patch"],
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
