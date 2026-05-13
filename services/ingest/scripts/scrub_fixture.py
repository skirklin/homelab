#!/usr/bin/env python3
"""Redact PII from money capture fixtures while preserving structure.

Usage:
    python scripts/scrub_fixture.py <input.json> <output.json>
    python scripts/scrub_fixture.py --check <input.json>

The scrubber walks JSON recursively and replaces:
    * Emails -> test@example.com
    * Per-institution login usernames (e.g. kirk4000, queenofblades) -> testuser
    * Cookie values for token/session/auth-bearing cookies -> REDACTED
    * Multi-digit numeric strings (account / customer IDs) -> XXXX1234
    * Person names (first/last/full) -> Test User
    * Long numeric customer IDs (>=15 digits) -> 999999999999999

All keys, types, array order, and field presence are preserved so the
scrubbed output still exercises the same parser/identity code paths.

Schema constraints preserved by design:
    * Ally `customers/self` URL substring stays intact.
    * Capital One `SIC_RM_VAL` cookie name stays intact; only the value's
      `<user>%7C<hash>` first segment is rewritten (URL-encoded composite).
    * Cookie names are never modified; only values are scrubbed when the
      name carries auth state (token/session/ciam/auth/bearer/etc.).

--check exits non-zero if scrubbing the input would change anything, i.e.
PII is still present.  Useful for CI / pre-commit.
"""
from __future__ import annotations

import argparse
import copy
import json
import re
import sys
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Configuration.  Names accumulate as we see new captures.  Adding a new
# username here is the supported way to scrub a new fixture; the runtime
# does not care about specific identifiers, only the redaction tools do.
# ---------------------------------------------------------------------------

# Per-institution login usernames seen in captures.  Replaced as substrings
# (case-insensitive) anywhere they appear, including URL-encoded composites.
KNOWN_USERNAMES: tuple[str, ...] = (
    "kirk4000",
    "queenofblades",
    "scottkirklin",
    "kirklin",
    # Capital One cookie carries just "kirk" before the |hash.
    # Order matters: longer names first so prefixes don't eat them.
    "kirk",
)

# Person names that may appear in profile responses, addresses, etc.
KNOWN_FIRST_NAMES: tuple[str, ...] = ("Scott", "Angela")
KNOWN_LAST_NAMES: tuple[str, ...] = ("Kirklin", "Chang", "Yenchi")
KNOWN_MIDDLE_NAMES: tuple[str, ...] = ("J",)

# Cookie names whose values carry session/auth state and must be redacted.
# Case-insensitive substring match.
SENSITIVE_COOKIE_NAME_FRAGMENTS: tuple[str, ...] = (
    "token", "session", "ciam", "auth", "bearer", "jsessionid", "sso",
    "tlt", "amt", "tgt", "abck", "akacd", "rxvisitor", "rxvt", "_ot",
    "sic_rm", "sic_si", "sic_lc", "c1_", "transaction_info", "bnes_",
    "ts_did", "ts_hwid", "awsalbcors", "udid", "pr_",
)

# JSON keys (case-insensitive exact match) whose string values should be
# replaced with REDACTED — high-entropy auth artefacts inside responseBodies.
SENSITIVE_KEYS: frozenset[str] = frozenset({
    "access_token", "id_token", "refresh_token", "bearer", "authorization",
    "api-key", "api-key-gw", "device_id", "session_id", "ephemeral_uid",
    "prehydrationid", "policy_request_id",
})

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
# Long numeric IDs (15+ digits) collapsed to a single canonical value.
LONG_NUMERIC_ID_RE = re.compile(r"\b\d{15,}\b")
# Phone numbers like 765-744-9016 or (765) 744-9016 or 7657449016.
PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b")
# Date of birth dates like 1986-08-11T00:00:00.000Z that look like raw DOBs.
# Conservative: only when surrounded by quotes & key is dob handled separately.
# US ZIP codes — only redact when in a field whose key is zip-like, handled by
# key matching, not regex on bare integers.

EMAIL_PLACEHOLDER = "test@example.com"
USERNAME_PLACEHOLDER = "testuser"
COOKIE_VALUE_PLACEHOLDER = "REDACTED"
ACCOUNT_NUMBER_PLACEHOLDER = "XXXX1234"
CUSTOMER_ID_PLACEHOLDER = "999999999999999"
PERSON_FIRST = "Test"
PERSON_LAST = "User"
PERSON_FULL = "Test User"
PHONE_PLACEHOLDER = "555-555-5555"
DOB_PLACEHOLDER = "1970-01-01T00:00:00.000Z"

# Keys whose string value is treated as an account/customer/person id and
# replaced wholesale (preserves shape, kills the underlying digits even
# when shorter than 15).
ACCOUNT_NUMBER_KEYS: frozenset[str] = frozenset({
    "accountnumber", "account_number", "account_no", "acctnum", "accountid",
    "account_id", "routingnumber", "routing_number", "routingnum",
    "cardnumber", "card_number", "ssn", "ssn4", "ein", "etin", "tin",
})

CUSTOMER_ID_KEYS: frozenset[str] = frozenset({
    "customerid", "customer_id", "cif", "cupid", "allyid", "guid", "lapiid",
    "investid", "ssoid", "userid", "user_id", "personid", "person_id",
})

NAME_KEYS_FIRST: frozenset[str] = frozenset({"first", "firstname", "first_name", "givenname"})
NAME_KEYS_LAST: frozenset[str] = frozenset({"last", "lastname", "last_name", "surname", "familyname"})
NAME_KEYS_MIDDLE: frozenset[str] = frozenset({"middle", "middlename", "middle_name"})
NAME_KEYS_FULL: frozenset[str] = frozenset({"fullname", "full_name", "displayname", "display_name", "preferredname", "preferred_name"})

PHONE_KEYS: frozenset[str] = frozenset({"phone", "phonenumber", "phone_number", "mobile"})
DOB_KEYS: frozenset[str] = frozenset({"dob", "dateofbirth", "date_of_birth", "birthdate"})
ADDRESS_KEYS_LINE: frozenset[str] = frozenset({"line1", "line2", "address1", "address2", "street"})
ADDRESS_KEYS_CITY: frozenset[str] = frozenset({"city"})
ADDRESS_KEYS_ZIP: frozenset[str] = frozenset({"zip", "zipcode", "zip_code", "postalcode", "postal_code"})

ADDRESS_LINE_PLACEHOLDER = "123 Test St"
ADDRESS_CITY_PLACEHOLDER = "Testville"
ADDRESS_ZIP_PLACEHOLDER = "00000"

# ---------------------------------------------------------------------------
# Scrubbers — each takes a string and returns a string.  Composed in order.
# ---------------------------------------------------------------------------


def _is_sensitive_cookie_name(name: str) -> bool:
    n = name.lower()
    return any(frag in n for frag in SENSITIVE_COOKIE_NAME_FRAGMENTS)


def _replace_usernames(s: str) -> str:
    """Substring-replace known usernames case-insensitively.

    Preserves URL-encoded composites: `kirk%7C<hash>` -> `testuser%7C<hash>`.
    """
    out = s
    for name in KNOWN_USERNAMES:
        if not name:
            continue
        out = re.sub(re.escape(name), USERNAME_PLACEHOLDER, out, flags=re.IGNORECASE)
    return out


def _replace_emails(s: str) -> str:
    return EMAIL_RE.sub(EMAIL_PLACEHOLDER, s)


def _replace_long_numeric_ids(s: str) -> str:
    return LONG_NUMERIC_ID_RE.sub(CUSTOMER_ID_PLACEHOLDER, s)


def _replace_names(s: str) -> str:
    out = s
    for last in KNOWN_LAST_NAMES:
        out = re.sub(rf"\b{re.escape(last)}\b", PERSON_LAST, out, flags=re.IGNORECASE)
    for first in KNOWN_FIRST_NAMES:
        out = re.sub(rf"\b{re.escape(first)}\b", PERSON_FIRST, out, flags=re.IGNORECASE)
    return out


def _replace_phones(s: str) -> str:
    return PHONE_RE.sub(PHONE_PLACEHOLDER, s)


def _scrub_string(s: str) -> str:
    """Apply all string-level scrubbers in a deterministic order."""
    s = _replace_emails(s)
    s = _replace_usernames(s)
    s = _replace_phones(s)
    s = _replace_long_numeric_ids(s)
    s = _replace_names(s)
    return s


# ---------------------------------------------------------------------------
# Recursive walker.
# ---------------------------------------------------------------------------


def _scrub(node: Any, *, parent_key: str | None = None, in_cookie: bool = False) -> Any:
    if isinstance(node, dict):
        # Detect cookie objects: has both name+value keys.  Then the value
        # field gets redacted only if the cookie name is sensitive.
        if "name" in node and "value" in node and isinstance(node.get("name"), str):
            new_dict: dict[str, Any] = {}
            cookie_name = node["name"]
            sensitive = _is_sensitive_cookie_name(cookie_name)
            for k, v in node.items():
                if k == "value" and isinstance(v, str):
                    # Always run username/email replacement so SIC_RM_VAL's
                    # `kirk%7C...` composite gets its username segment
                    # replaced even though the cookie value is also
                    # subsequently REDACTED for non-SIC_RM cookies.
                    scrubbed_value = _scrub_string(v)
                    if sensitive and cookie_name.upper() != "SIC_RM_VAL":
                        scrubbed_value = COOKIE_VALUE_PLACEHOLDER
                    new_dict[k] = scrubbed_value
                else:
                    new_dict[k] = _scrub(v, parent_key=k, in_cookie=True)
            return new_dict

        new_dict = {}
        for k, v in node.items():
            kl = k.lower() if isinstance(k, str) else ""
            if isinstance(v, str):
                if kl in SENSITIVE_KEYS:
                    new_dict[k] = COOKIE_VALUE_PLACEHOLDER
                elif kl in ACCOUNT_NUMBER_KEYS:
                    new_dict[k] = ACCOUNT_NUMBER_PLACEHOLDER
                elif kl in CUSTOMER_ID_KEYS:
                    new_dict[k] = CUSTOMER_ID_PLACEHOLDER
                elif kl in NAME_KEYS_FIRST:
                    new_dict[k] = PERSON_FIRST
                elif kl in NAME_KEYS_LAST:
                    new_dict[k] = PERSON_LAST
                elif kl in NAME_KEYS_MIDDLE:
                    new_dict[k] = "T"
                elif kl in NAME_KEYS_FULL:
                    new_dict[k] = PERSON_FULL
                elif kl in PHONE_KEYS:
                    new_dict[k] = PHONE_PLACEHOLDER
                elif kl in DOB_KEYS:
                    new_dict[k] = DOB_PLACEHOLDER
                elif kl in ADDRESS_KEYS_LINE:
                    new_dict[k] = ADDRESS_LINE_PLACEHOLDER
                elif kl in ADDRESS_KEYS_CITY:
                    new_dict[k] = ADDRESS_CITY_PLACEHOLDER
                elif kl in ADDRESS_KEYS_ZIP:
                    new_dict[k] = ADDRESS_ZIP_PLACEHOLDER
                else:
                    new_dict[k] = _scrub_string(v)
            else:
                new_dict[k] = _scrub(v, parent_key=k, in_cookie=in_cookie)
        return new_dict

    if isinstance(node, list):
        return [_scrub(item, parent_key=parent_key, in_cookie=in_cookie) for item in node]

    if isinstance(node, str):
        return _scrub_string(node)

    return node


def scrub(doc: Any) -> Any:
    """Return a deep-scrubbed copy of doc."""
    return _scrub(copy.deepcopy(doc))


# ---------------------------------------------------------------------------
# Check mode — diff input against scrub(input), report first PII path.
# ---------------------------------------------------------------------------


def _find_pii_path(node: Any, scrubbed: Any, path: str = "$") -> str | None:
    if type(node) is not type(scrubbed):
        return path
    if isinstance(node, dict):
        for k in node:
            sub = _find_pii_path(node[k], scrubbed.get(k), f"{path}.{k}")
            if sub is not None:
                return sub
        return None
    if isinstance(node, list):
        for i, (a, b) in enumerate(zip(node, scrubbed)):
            sub = _find_pii_path(a, b, f"{path}[{i}]")
            if sub is not None:
                return sub
        return None
    if node != scrubbed:
        return path
    return None


# ---------------------------------------------------------------------------
# CLI.
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("input", type=Path, help="input JSON capture")
    p.add_argument("output", type=Path, nargs="?", help="output JSON path (omit with --check)")
    p.add_argument("--check", action="store_true",
                   help="exit non-zero if scrubbing would change anything")
    args = p.parse_args(argv)

    with args.input.open("r", encoding="utf-8") as f:
        doc = json.load(f)

    scrubbed = scrub(doc)

    if args.check:
        diff = _find_pii_path(doc, scrubbed)
        if diff is not None:
            print(f"PII detected at: {diff}", file=sys.stderr)
            return 1
        print(f"clean: {args.input}")
        return 0

    if args.output is None:
        p.error("output path required unless --check is set")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        json.dump(scrubbed, f, indent=2, sort_keys=False)
        f.write("\n")
    print(f"scrubbed {args.input} -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
