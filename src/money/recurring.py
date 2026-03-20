"""Recurring transaction detection.

Analyzes transaction history to identify recurring charges — same merchant,
similar amount, regular intervals. Stores detected patterns for review.
"""

import logging
from datetime import date
from typing import Any

from money.db import Database

log = logging.getLogger(__name__)


def detect_recurring(db: Database, min_occurrences: int = 3) -> int:
    """Detect recurring transaction patterns.

    Groups transactions by description similarity, checks for regular intervals,
    and stores detected patterns. Returns number of patterns found.
    """
    # Get all spending transactions grouped by description
    rows = db.conn.execute("""
        SELECT t.description, t.category_path, t.amount, t.date
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        WHERE a.account_type IN ('checking', 'credit_card')
          AND t.amount < 0
          AND (t.category_path IS NULL OR t.category_path NOT LIKE 'capital%')
        ORDER BY t.description, t.date
    """).fetchall()

    # Group by description
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        desc = row["description"] or ""
        if not desc:
            continue
        groups.setdefault(desc, []).append({
            "amount": row["amount"],
            "date": row["date"],
            "category_path": row["category_path"],
        })

    # Clear old detected patterns (keep confirmed/dismissed)
    db.conn.execute("DELETE FROM recurring_patterns WHERE status = 'detected'")

    count = 0
    for desc, txns in groups.items():
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
        last_seen = dates[-1].isoformat()

        # Skip if already confirmed/dismissed with same description
        existing = db.conn.execute(
            "SELECT id FROM recurring_patterns WHERE description = ? AND status != 'detected'",
            (desc,),
        ).fetchone()
        if existing:
            continue

        db.conn.execute(
            """INSERT INTO recurring_patterns
               (description, category_path, avg_amount, frequency, match_count, last_seen)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (desc, category_path, avg_amount, frequency, len(txns), last_seen),
        )
        count += 1

    db.conn.commit()
    log.info("Detected %d recurring patterns from %d description groups", count, len(groups))
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
        SELECT id, description, category_path, avg_amount, frequency,
               match_count, last_seen, status, created_at
        FROM recurring_patterns
        WHERE status IN ('detected', 'confirmed')
        ORDER BY avg_amount DESC
    """).fetchall()

    return [
        {
            "id": row["id"],
            "description": row["description"],
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
    """Convert a per-period amount to annual."""
    multipliers = {
        "weekly": 52,
        "monthly": 12,
        "bimonthly": 6,
        "quarterly": 4,
        "annual": 1,
    }
    return amount * multipliers.get(frequency, 12)


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
