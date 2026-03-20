"""Recurring transaction detection.

Analyzes transaction history to identify recurring charges by grouping
transactions that match the same categorization rule pattern, then checking
for regular intervals and consistent amounts.
"""

import logging
from datetime import date
from typing import Any

from money.categorize import load_rules
from money.db import Database

log = logging.getLogger(__name__)


def detect_recurring(db: Database, min_occurrences: int = 3) -> int:
    """Detect recurring transaction patterns.

    Groups transactions by which categorization rule pattern they match,
    checks for regular intervals, and stores detected patterns.
    Returns number of patterns found.
    """
    rules = load_rules()
    if not rules:
        return 0

    # Get all spending transactions
    rows = db.conn.execute("""
        SELECT t.id, t.description, t.category, t.category_path, t.amount, t.date
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE a.account_type IN ('checking', 'credit_card')
          AND t.amount < 0
          AND (t.category_path IS NULL OR t.category_path NOT LIKE 'capital%')
        ORDER BY t.date
    """).fetchall()

    # Import the LIKE matcher
    from money.categorize import _like_match, _pattern_specificity

    # For each transaction, find its best matching rule pattern
    # (same logic as apply_rules but we track the pattern)
    desc_rules = [r for r in rules if not r.pattern.startswith("category:")]
    cat_rules = [r for r in rules if r.pattern.startswith("category:")]

    pattern_groups: dict[str, list[dict[str, Any]]] = {}

    for row in rows:
        description = (row["description"] or "").upper()
        category = row["category"] or ""

        best_pattern: str | None = None
        best_specificity = -1

        for rule in desc_rules:
            pat = rule.pattern.upper()
            if _like_match(description, pat):
                spec = _pattern_specificity(rule.pattern)
                if spec > best_specificity:
                    best_specificity = spec
                    best_pattern = rule.pattern

        for rule in cat_rules:
            cat_value = rule.pattern.removeprefix("category:")
            if category == cat_value:
                spec = _pattern_specificity(rule.pattern)
                if spec > best_specificity:
                    best_specificity = spec
                    best_pattern = rule.pattern

        if best_pattern:
            pattern_groups.setdefault(best_pattern, []).append({
                "amount": row["amount"],
                "date": row["date"],
                "category_path": row["category_path"],
                "description": row["description"],
            })

    # Clear old detected patterns (keep confirmed/dismissed)
    db.conn.execute("DELETE FROM recurring_patterns WHERE status = 'detected'")

    count = 0
    for pattern, txns in pattern_groups.items():
        if len(txns) < min_occurrences:
            continue

        # Check if amounts are similar (within 20% of median)
        amounts = sorted(abs(t["amount"]) for t in txns)
        median_amount = amounts[len(amounts) // 2]
        if median_amount == 0:
            continue
        similar = [a for a in amounts if abs(a - median_amount) / median_amount < 0.2]
        if len(similar) < min_occurrences:
            continue

        # Check interval regularity
        dates = sorted(date.fromisoformat(t["date"]) for t in txns)
        intervals = [
            (dates[i + 1] - dates[i]).days for i in range(len(dates) - 1)
        ]
        if not intervals:
            continue

        avg_interval = sum(intervals) / len(intervals)
        frequency = _classify_frequency(avg_interval)
        if not frequency:
            continue

        # Check interval consistency (stddev < 30% of mean)
        if avg_interval > 0:
            variance = sum((iv - avg_interval) ** 2 for iv in intervals) / len(intervals)
            stddev = variance ** 0.5
            if stddev / avg_interval > 0.3:
                continue

        avg_amount = sum(abs(t["amount"]) for t in txns) / len(txns)
        category_path = txns[-1]["category_path"]
        # Use the most common description as the display name
        desc_counts: dict[str, int] = {}
        for t in txns:
            d = t["description"] or pattern
            desc_counts[d] = desc_counts.get(d, 0) + 1
        display_desc = max(desc_counts, key=lambda d: desc_counts[d])
        last_seen = dates[-1].isoformat()

        # If already confirmed with same category_path and similar amount,
        # update its stats but don't create a duplicate
        existing = db.conn.execute(
            """SELECT id FROM recurring_patterns
               WHERE category_path = ? AND status = 'confirmed'
               AND ABS(avg_amount - ?)
                   / CASE WHEN avg_amount = 0 THEN 1 ELSE avg_amount END
                   < 0.2""",
            (category_path, avg_amount),
        ).fetchone()
        if existing:
            db.conn.execute(
                """UPDATE recurring_patterns
                   SET avg_amount = ?, match_count = ?, last_seen = ?,
                       description = ?, pattern = ?
                   WHERE id = ?""",
                (avg_amount, len(txns), last_seen, display_desc, pattern,
                 existing["id"]),
            )
            continue

        db.conn.execute(
            """INSERT INTO recurring_patterns
               (description, category_path, avg_amount, frequency, match_count,
                last_seen, pattern)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (display_desc, category_path, avg_amount, frequency, len(txns),
             last_seen, pattern),
        )
        count += 1

    db.conn.commit()
    log.info("Detected %d recurring patterns from %d rule groups", count, len(pattern_groups))
    return count


def _classify_frequency(avg_interval_days: float) -> str | None:
    """Classify an average interval into a frequency label."""
    if 5 <= avg_interval_days <= 10:
        return "weekly"
    if 25 <= avg_interval_days <= 35:
        return "monthly"
    if 55 <= avg_interval_days <= 70:
        return "bimonthly"
    if 80 <= avg_interval_days <= 100:
        return "quarterly"
    if 340 <= avg_interval_days <= 390:
        return "annual"
    return None


def get_recurring_patterns(db: Database) -> list[dict[str, Any]]:
    """Get all recurring patterns (detected + confirmed)."""
    rows = db.conn.execute("""
        SELECT id, description, display_name, category_path, avg_amount, frequency,
               match_count, last_seen, status, pattern, created_at
        FROM recurring_patterns
        WHERE status IN ('detected', 'confirmed')
        ORDER BY avg_amount DESC
    """).fetchall()

    return [
        {
            "id": row["id"],
            "description": row["description"],
            "display_name": row["display_name"] or row["description"],
            "pattern": row["pattern"],
            "category_path": row["category_path"],
            "avg_amount": row["avg_amount"],
            "frequency": row["frequency"],
            "match_count": row["match_count"],
            "last_seen": row["last_seen"],
            "status": row["status"],
            "annual_cost": _annualize(row["avg_amount"], row["frequency"]),
        }
        for row in rows
    ]


def _annualize(amount: float, frequency: str) -> float:
    multipliers = {
        "weekly": 52,
        "monthly": 12,
        "bimonthly": 6,
        "quarterly": 4,
        "annual": 1,
    }
    return amount * multipliers.get(frequency, 12)


def generate_display_names(db: Database) -> int:
    """Use Claude to generate friendly display names for recurring patterns."""
    import json
    import shutil
    import subprocess

    claude_path = shutil.which("claude")
    if not claude_path:
        log.error("Claude CLI not found")
        return 0

    rows = db.conn.execute("""
        SELECT id, description, category_path, avg_amount, frequency
        FROM recurring_patterns
        WHERE status IN ('detected', 'confirmed')
          AND (display_name IS NULL OR display_name = description)
    """).fetchall()

    if not rows:
        return 0

    lines = []
    for r in rows:
        lines.append(
            f"  id={r['id']}  \"{r['description']}\""
            f"  category={r['category_path']}  ${r['avg_amount']:.2f}/{r['frequency']}"
        )

    prompt = f"""Give each of these recurring transactions a short, clean display name.
The descriptions come from bank statements and are often cryptic.
Keep names short (2-4 words), lowercase, human-readable.
Good examples: "netflix", "new york times", "gym membership", "home insurance"
Bad examples: "REINSUREPRO NREIG~ Future Amount: 185.46 ~ Tran: ACHDW"

Transactions:
{chr(10).join(lines)}

Respond with ONLY a JSON object mapping id to display name, no markdown:
{{"1": "clean name", "2": "another name"}}"""

    try:
        result = subprocess.run(
            [claude_path, "--print", "--output-format", "json", "--model", "haiku", "-p", prompt],
            capture_output=True, text=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        log.error("Claude timed out generating display names")
        return 0

    if result.returncode != 0:
        return 0

    try:
        output = json.loads(result.stdout)
        text: str = output.get("result", output.get("text", result.stdout))
    except json.JSONDecodeError:
        text = result.stdout

    # Parse JSON from response
    try:
        start = text.index("{")
        end = text.rindex("}") + 1
        names: dict[str, str] = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        log.warning("Could not parse display names from Claude response")
        return 0

    count = 0
    for id_str, name in names.items():
        try:
            db.conn.execute(
                "UPDATE recurring_patterns SET display_name = ? WHERE id = ?",
                (name, int(id_str)),
            )
            count += 1
        except (ValueError, Exception):
            continue

    db.conn.commit()
    log.info("Generated %d display names", count)
    return count


def confirm_pattern(db: Database, pattern_id: int) -> None:
    db.conn.execute(
        "UPDATE recurring_patterns SET status = 'confirmed' WHERE id = ?",
        (pattern_id,),
    )
    db.conn.commit()


def dismiss_pattern(db: Database, pattern_id: int) -> None:
    db.conn.execute(
        "UPDATE recurring_patterns SET status = 'dismissed' WHERE id = ?",
        (pattern_id,),
    )
    db.conn.commit()
