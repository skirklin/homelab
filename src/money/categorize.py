"""Category rule engine for transactions.

Rules are loaded from ~/.config/money/categories.yaml and applied to transactions
to populate category_path in the database.

The YAML file is the source of truth for rules — it survives database rebuilds.

YAML format is a nested dict where keys are path segments and leaf lists contain
SQL LIKE patterns (or "category:VALUE" to match the raw category field).
Longest matching pattern wins when multiple rules match a transaction.

Example:
    rules:
      Travel:
        Lodging:
          - "%AIRBNB%"
          - "%HOTEL%"
        Airfare:
          - "%UNITED%AIR%"
      Pets:
        - "%MIDTOWN MUTTS%"

This produces rules:
    "%AIRBNB%"      → "Travel/Lodging"
    "%HOTEL%"       → "Travel/Lodging"
    "%UNITED%AIR%"  → "Travel/Airfare"
    "%MIDTOWN MUTTS%" → "Pets"
"""

import logging
from typing import Any

import yaml  # type: ignore[import-untyped]

from money.config import CONFIG_DIR
from money.db import Database
from money.models import CategoryRule

log = logging.getLogger(__name__)

RULES_FILE = CONFIG_DIR / "categories.yaml"


def load_config() -> dict[str, Any]:
    """Load the categories config from YAML."""
    if not RULES_FILE.exists():
        raise FileNotFoundError(
            f"No categories config at {RULES_FILE}. "
            "Create it with categorization rules."
        )
    data: dict[str, Any] = yaml.safe_load(RULES_FILE.read_text())
    return data


def _parse_rules_recursive(
    node: dict[str, Any] | list[str],
    path: list[str],
) -> list[CategoryRule]:
    """Recursively walk the YAML tree and produce flat CategoryRule list.

    Dict keys become path segments. Lists at any level contain patterns
    assigned to the current path.
    """
    if isinstance(node, list):
        category_path = "/".join(path)
        return [CategoryRule(pattern=p, category_path=category_path) for p in node]

    rules: list[CategoryRule] = []
    for key, child in node.items():
        if isinstance(child, dict):
            rules.extend(_parse_rules_recursive(child, path + [key]))
        elif isinstance(child, list):
            category_path = "/".join(path + [key])
            rules.extend(
                CategoryRule(pattern=str(p), category_path=category_path) for p in child
            )
        # Ignore other types (e.g. scalar metadata keys)
    return rules


def load_rules() -> list[CategoryRule]:
    """Load category rules from the YAML config file."""
    config = load_config()
    rules_tree: dict[str, Any] | list[str] = config.get("rules", {})
    if not isinstance(rules_tree, dict):
        return []
    return _parse_rules_recursive(rules_tree, [])


def _pattern_specificity(pattern: str) -> int:
    """Score a pattern by specificity for longest-match-wins resolution.

    Strips SQL LIKE wildcards (%) and counts remaining characters.
    category: patterns are penalized so description-based rules take
    priority — bank-assigned categories are less reliable than merchant
    name matching.
    """
    if pattern.startswith("category:"):
        return 0
    return len(pattern.replace("%", ""))


def apply_rules(db: Database, transaction_ids: list[int] | None = None) -> int:
    """Apply category rules to transactions, populating category_path.

    For each transaction, all matching rules are found. The rule with the
    longest (most specific) pattern wins. Ties are broken by the rule's
    position in the config (first wins).

    Returns count of transactions categorized.
    """
    rules = load_rules()
    if not rules:
        log.warning("No rules loaded from %s", RULES_FILE)
        return 0

    db.clear_category_paths()

    # Separate description-pattern rules from category-prefix rules
    desc_rules = [r for r in rules if not r.pattern.startswith("category:")]
    cat_rules = [r for r in rules if r.pattern.startswith("category:")]

    txn_filter = ""
    txn_params: list[object] = []
    if transaction_ids is not None:
        placeholders = ",".join("?" for _ in transaction_ids)
        txn_filter = f" AND t.id IN ({placeholders})"
        txn_params = list(transaction_ids)

    # Fetch all candidate transactions
    rows = db.conn.execute(
        f"""SELECT t.id, t.description, t.category
            FROM transactions t
            JOIN accounts a ON t.account_id = a.id
            WHERE a.account_type IN ('checking', 'credit_card')
            {txn_filter}""",
        txn_params,
    ).fetchall()

    # Build per-transaction best match
    count = 0
    updates: list[tuple[str, int]] = []

    for row in rows:
        txn_id: int = row["id"]
        description: str = (row["description"] or "").upper()
        category: str = row["category"] or ""

        best_rule: CategoryRule | None = None
        best_specificity = -1

        for rule in desc_rules:
            # Convert SQL LIKE pattern to a simple match
            pat = rule.pattern.upper()
            if _like_match(description, pat):
                spec = _pattern_specificity(rule.pattern)
                if spec > best_specificity:
                    best_specificity = spec
                    best_rule = rule

        for rule in cat_rules:
            cat_value = rule.pattern.removeprefix("category:")
            if category == cat_value:
                spec = _pattern_specificity(rule.pattern)
                if spec > best_specificity:
                    best_specificity = spec
                    best_rule = rule

        if best_rule is not None:
            updates.append((best_rule.category_path, txn_id))
            count += 1

    # Batch update
    db.conn.executemany(
        "UPDATE transactions SET category_path = ? WHERE id = ?",
        updates,
    )
    db.conn.commit()

    log.info("Categorized %d / %d transactions from %d rules", count, len(rows), len(rules))
    return count


def _like_match(text: str, pattern: str) -> bool:
    """Match a SQL LIKE pattern (with % wildcards) against text.

    Both text and pattern should already be uppercased.
    """
    # Simple recursive LIKE matcher
    return _like_match_impl(text, 0, pattern, 0)


def _like_match_impl(text: str, ti: int, pattern: str, pi: int) -> bool:
    while pi < len(pattern):
        if pattern[pi] == "%":
            # Skip consecutive %
            while pi < len(pattern) and pattern[pi] == "%":
                pi += 1
            if pi == len(pattern):
                return True
            # Try matching the rest from every position
            return any(
                _like_match_impl(text, ti2, pattern, pi)
                for ti2 in range(ti, len(text) + 1)
            )
        else:
            if ti >= len(text) or text[ti] != pattern[pi]:
                return False
            ti += 1
            pi += 1
    return ti == len(text)


def dry_run_pattern(
    db: Database,
    pattern: str,
    category_path: str,
) -> list[dict[str, Any]]:
    """Preview what a new rule would do without applying it.

    Returns list of affected transactions with their current and proposed
    category_path values.
    """
    is_cat_rule = pattern.startswith("category:")

    if is_cat_rule:
        cat_value = pattern.removeprefix("category:")
        rows = db.conn.execute(
            """SELECT t.id, t.date, t.amount, t.description, t.category,
                      t.category_path
               FROM transactions t
               JOIN accounts a ON t.account_id = a.id
               WHERE a.account_type IN ('checking', 'credit_card')
                 AND t.category = ?
               ORDER BY t.date DESC""",
            (cat_value,),
        ).fetchall()
    else:
        rows = db.conn.execute(
            """SELECT t.id, t.date, t.amount, t.description, t.category,
                      t.category_path
               FROM transactions t
               JOIN accounts a ON t.account_id = a.id
               WHERE a.account_type IN ('checking', 'credit_card')
                 AND UPPER(t.description) LIKE UPPER(?)
               ORDER BY t.date DESC""",
            (pattern,),
        ).fetchall()

    results: list[dict[str, Any]] = []
    for row in rows:
        results.append({
            "id": row["id"],
            "date": row["date"],
            "amount": row["amount"],
            "description": row["description"],
            "current_category_path": row["category_path"],
            "proposed_category_path": category_path,
            "would_change": row["category_path"] != category_path,
        })
    return results
