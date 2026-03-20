"""Category rule engine for transactions.

Rules are loaded from ~/.config/money/categories.yaml and applied to transactions
to populate transaction_tags and display_category in the database.

The YAML file is the source of truth for rules — it survives database rebuilds.
"""

import logging
from typing import Any

import yaml  # type: ignore[import-untyped]

from money.config import CONFIG_DIR
from money.db import Database
from money.models import CategoryRule

log = logging.getLogger(__name__)

RULES_FILE = CONFIG_DIR / "categories.yaml"

# Categories whose raw values are too generic — fall through to description
_DEFAULT_GENERIC_CATEGORIES = frozenset({
    "ACH", "Bill Pay", "POS", "Unknown", "Other",
    "Other Services", "Other Travel", "Fee",
})


def load_config() -> dict[str, Any]:
    """Load the categories config from YAML."""
    if not RULES_FILE.exists():
        raise FileNotFoundError(
            f"No categories config at {RULES_FILE}. "
            "Create it with categorization rules."
        )
    data: dict[str, Any] = yaml.safe_load(RULES_FILE.read_text())
    return data


def load_rules() -> list[CategoryRule]:
    """Load category rules from the YAML config file."""
    config = load_config()
    rules: list[CategoryRule] = []
    for entry in config.get("rules", []):
        rules.append(CategoryRule(
            pattern=entry["pattern"],
            tag=entry["tag"],
            priority=entry.get("priority", 0),
            display_category=entry.get("display_category"),
        ))
    return rules


def generic_categories() -> frozenset[str]:
    """Return the set of generic category names that should fall through to description."""
    try:
        config = load_config()
        return frozenset(config.get("generic_categories", _DEFAULT_GENERIC_CATEGORIES))
    except FileNotFoundError:
        return _DEFAULT_GENERIC_CATEGORIES


def collection_meta() -> dict[str, dict[str, str]]:
    """Return collection metadata (label, description) from config."""
    try:
        config = load_config()
        return dict(config.get("collections", {}))
    except FileNotFoundError:
        return {}


def apply_rules(db: Database, transaction_ids: list[int] | None = None) -> int:
    """Apply category rules from the YAML config to transactions.

    Clears existing rule-based tags, then reapplies all rules.
    Sets display_category from the highest-priority matching rule.
    Falls back to description when the raw category is generic.

    Returns count of transactions tagged.
    """
    rules = load_rules()
    if not rules:
        log.warning("No rules loaded from %s", RULES_FILE)
        return 0

    # Sort by priority DESC so highest-priority display_category wins
    rules.sort(key=lambda r: r.priority, reverse=True)

    db.clear_tags(source="rule")
    db.clear_display_categories()

    # Separate description-pattern rules from category-prefix rules
    desc_rules = [r for r in rules if not r.pattern.startswith("category:")]
    cat_rules = [r for r in rules if r.pattern.startswith("category:")]

    txn_filter = ""
    txn_params: list[object] = []
    if transaction_ids is not None:
        placeholders = ",".join("?" for _ in transaction_ids)
        txn_filter = f" AND t.id IN ({placeholders})"
        txn_params = list(transaction_ids)

    # Apply tags
    for rule in desc_rules:
        db.conn.execute(
            f"""INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, source)
                SELECT t.id, ?, 'rule'
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.account_type IN ('checking', 'credit_card')
                  AND UPPER(t.description) LIKE UPPER(?){txn_filter}""",
            [rule.tag, rule.pattern, *txn_params],
        )

    for rule in cat_rules:
        cat_value = rule.pattern.removeprefix("category:")
        db.conn.execute(
            f"""INSERT OR IGNORE INTO transaction_tags (transaction_id, tag, source)
                SELECT t.id, ?, 'rule'
                FROM transactions t
                JOIN accounts a ON t.account_id = a.id
                WHERE a.account_type IN ('checking', 'credit_card')
                  AND t.category = ?{txn_filter}""",
            [rule.tag, cat_value, *txn_params],
        )

    db.conn.commit()

    # Set display_category (highest priority first, only if not yet set)
    for rule in desc_rules:
        if rule.display_category is None:
            continue
        db.conn.execute(
            f"""UPDATE transactions
                SET display_category = ?
                WHERE display_category IS NULL
                  AND UPPER(description) LIKE UPPER(?){txn_filter.replace('t.id', 'id')}""",
            [rule.display_category, rule.pattern, *txn_params],
        )

    for rule in cat_rules:
        if rule.display_category is None:
            continue
        cat_value = rule.pattern.removeprefix("category:")
        db.conn.execute(
            f"""UPDATE transactions
                SET display_category = ?
                WHERE display_category IS NULL
                  AND category = ?{txn_filter.replace('t.id', 'id')}""",
            [rule.display_category, cat_value, *txn_params],
        )

    # Fallback: use description when category is generic
    generics = generic_categories()
    generic_ph = ",".join("?" for _ in generics)
    db.conn.execute(
        f"""UPDATE transactions
            SET display_category = description
            WHERE display_category IS NULL
              AND (category IS NULL OR category IN ({generic_ph}))
              {txn_filter.replace('AND t.id', 'AND id')}""",
        [*generics, *txn_params],
    )

    db.conn.commit()

    tagged_row = db.conn.execute(
        "SELECT COUNT(DISTINCT transaction_id) FROM transaction_tags WHERE source = 'rule'"
    ).fetchone()
    assert tagged_row is not None
    count = int(tagged_row[0])
    log.info("Tagged %d transactions from %d rules", count, len(rules))
    return count
