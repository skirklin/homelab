#!/usr/bin/env bash
# lint-pb-migrations.sh — scan PB migrations + hooks for the canonical
# goja JSON byte-array bug that destroyed data on 2026-05-22.
#
# The bug: PB stores JSON columns as Go []byte. In goja, `record.get(jsonField)`
# can surface as a JS array of byte values (one number per UTF-8 byte), not a
# parsed object. `JSON.parse(JSON.stringify(...))` on that input round-trips
# the byte-array form into a JS array of numbers — silently corrupting per-row
# transforms. See infra/pocketbase/pb_migrations/lib/pb-json.js + the
# 20260522_221157_life_event_unified_shape.js historical note.
#
# Three already-applied migrations are allowlisted as frozen historical record
# (re-running them is impossible, and re-rewriting them just because the lint
# is unhappy would risk breaking the recovery scripts' assumptions about what
# shape they produced). All other migrations and ALL hooks are checked.
#
# Per-line opt-out: append `// lint-skip: <reason>` to acknowledge a known
# false positive. The lint will count it but not fail.
#
# Exit code: 0 = clean, 1 = at least one offending file:line, 2 = bad usage.

set -euo pipefail

# Run from repo root so paths in output are stable regardless of cwd.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

MIGRATIONS_DIR="infra/pocketbase/pb_migrations"
HOOKS_DIR="infra/pocketbase/pb_hooks"

if [ ! -d "$MIGRATIONS_DIR" ] || [ ! -d "$HOOKS_DIR" ]; then
    echo "lint-pb-migrations: expected $MIGRATIONS_DIR and $HOOKS_DIR to exist" >&2
    exit 2
fi

# Frozen migrations — already applied to prod, re-rewriting them risks
# diverging from what the recovery scripts assume was produced. The
# 20260522_221157 one is specifically the migration that triggered the bug
# class this lint exists to prevent; it stays as-is as a historical record
# (its big HISTORICAL NOTE block at the top is the warning to future
# travelers). The other two were ported with the same broken pattern but
# coincidentally on tables that didn't hit the failure path before recovery
# completed. All three carry the bug pattern, all three stay frozen.
ALLOWLIST_FILES=(
    "$MIGRATIONS_DIR/20260522_221157_life_event_unified_shape.js"
    "$MIGRATIONS_DIR/20260522_230000_task_events_unified_shape.js"
    "$MIGRATIONS_DIR/20260522_230100_recipe_events_unified_shape.js"
)

is_allowlisted() {
    local f="$1"
    for a in "${ALLOWLIST_FILES[@]}"; do
        [ "$f" = "$a" ] && return 0
    done
    return 1
}

# Skip the lib/ helper directory (utility code, not a migration) and the
# pb-json.test.* file if it shows up.
collect_files() {
    # Migrations: top-level *.js only (lib/ is helper code).
    find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name "*.js" | sort
    # Hooks: every *.pb.js.
    find "$HOOKS_DIR" -maxdepth 1 -type f -name "*.pb.js" | sort
}

# Track findings.
FAIL_COUNT=0
SKIP_COUNT=0

# A finding has a location, a pattern label, and a suggestion. We emit one
# line per finding so output is greppable: FILE:LINE — <label> — <suggestion>.
emit() {
    local file="$1" line="$2" label="$3" suggestion="$4"
    printf 'OFFENDING %s:%s — %s — suggestion: %s\n' "$file" "$line" "$label" "$suggestion"
}

# Pattern A: `JSON.parse(JSON.stringify(` within 5 lines AFTER a `.get(` call
# on a record-shaped identifier. We grep for the round-trip pattern and look
# backward up to 5 lines for a record.get / r.get / e.record.get / similar.
check_round_trip_after_get() {
    local file="$1"
    # Read entire file into an array of lines so we can window-scan cheaply.
    mapfile -t LINES < "$file"
    local n=${#LINES[@]}

    local i
    for (( i = 0; i < n; i++ )); do
        local line="${LINES[$i]}"

        # Skip pure comment lines (// or  *) so the doc paragraphs about the
        # bug don't trip the lint on themselves.
        case "$line" in
            *"// lint-skip:"*)
                SKIP_COUNT=$((SKIP_COUNT + 1))
                continue
                ;;
        esac
        # Trim leading whitespace for the comment-only check.
        local trimmed="${line#"${line%%[![:space:]]*}"}"
        case "$trimmed" in
            "//"*|"/*"*|"*"*|"*/")
                continue
                ;;
        esac

        # Look for the canonical round-trip on this line.
        case "$line" in
            *"JSON.parse(JSON.stringify("*)
                ;;
            *)
                continue
                ;;
        esac

        # If the round-trip is on a `.get(` argument, that's the canonical bug
        # shape regardless of preceding context — emit immediately.
        case "$line" in
            *".get("*)
                emit "$file" "$((i + 1))" \
                    "JSON.parse(JSON.stringify(<record>.get(...))) — goja byte-array bug" \
                    "use unwrapPbJson() from lib/pb-json.js"
                FAIL_COUNT=$((FAIL_COUNT + 1))
                continue
                ;;
        esac

        # Otherwise scan up to 5 lines back for a .get( reference. This
        # catches the two-statement form:
        #   const raw = r.get("data");
        #   const obj = JSON.parse(JSON.stringify(raw));
        local j start=$((i - 5))
        [ $start -lt 0 ] && start=0
        local found_get=""
        for (( j = i - 1; j >= start; j-- )); do
            case "${LINES[$j]}" in
                *".get("*)
                    found_get="$((j + 1))"
                    break
                    ;;
            esac
        done
        if [ -n "$found_get" ]; then
            emit "$file" "$((i + 1))" \
                "JSON.parse(JSON.stringify(...)) within 5 lines of .get() at $file:$found_get — goja byte-array bug" \
                "use unwrapPbJson() from lib/pb-json.js"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    done
}

# Pattern B: unwrapped JSON field access — `.get("<jsonField>")` directly
# followed (within 3 lines) by a property read like `.foo` / `.notes` on
# the same identifier, when the result hasn't passed through unwrapPbJson.
# Conservative: only known JSON column names are flagged (anything looser
# false-positives on relation .id reads etc.). Reviewer can add a column
# here when a new JSON field lands.
JSON_FIELD_NAMES=(
    "data"
    "entries"
    "labels"
    "travel_slugs"
    "shopping_slugs"
    "household_slugs"
    "recipe_boxes"
    "owners"
    "notification_state"
    "reminder_times"
)

check_unwrapped_json_field_access() {
    local file="$1"
    mapfile -t LINES < "$file"
    local n=${#LINES[@]}

    # Build the alternation pattern once.
    local field_alt
    field_alt="$(IFS='|'; echo "${JSON_FIELD_NAMES[*]}")"

    local i
    for (( i = 0; i < n; i++ )); do
        local line="${LINES[$i]}"

        # Skip lint-skipped lines and comment-only lines.
        case "$line" in
            *"// lint-skip:"*)
                SKIP_COUNT=$((SKIP_COUNT + 1))
                continue
                ;;
        esac
        local trimmed="${line#"${line%%[![:space:]]*}"}"
        case "$trimmed" in
            "//"*|"/*"*|"*"*|"*/")
                continue
                ;;
        esac

        # Match `.get("<jsonField>")` and capture the assigned variable name
        # if any. We only emit when a property read on that variable shows up
        # within the next 3 lines AND no `unwrapPbJson` appears between.
        local field=""
        local var=""
        # Try to extract `const|let|var <var> = ... .get("<field>")` form.
        if [[ "$line" =~ (const|let|var)[[:space:]]+([a-zA-Z_$][a-zA-Z0-9_$]*)[[:space:]]*=[^=].*\.get\(\"($field_alt)\"\) ]]; then
            var="${BASH_REMATCH[2]}"
            field="${BASH_REMATCH[3]}"
        else
            continue
        fi

        # If the `.get(...)` is already wrapped by a known-safe helper on
        # this line, we're fine. Safe wrappers in this repo:
        #   - `unwrapPbJson(...)` / `unwrapPbJsonObject(...)` (migrations + hooks)
        #   - `toJsArray(...)` / `toPlainObject(...)` (hooks)
        #   - raw `Array.prototype.slice.call(...)`
        # Anything that takes the goja value and produces a plain JS value
        # before assignment is acceptable.
        case "$line" in
            *"unwrapPbJson"*"("*) continue ;;
            *"toJsArray("*) continue ;;
            *"toPlainObject("*) continue ;;
            *"Array.prototype.slice.call("*) continue ;;
        esac

        # Scan next 3 lines for `<var>.<prop>` PROPERTY READ that implies
        # parsed-object semantics. Method calls on goja-wrapped arrays
        # (indexOf/includes/forEach/map/filter/slice/length/push) are NOT
        # treated as evidence of the bug — per sharing.pb.js header note
        # (b), reading via indexOf works fine on the raw value; it's the
        # `.push` MUTATION that goja mangles, and that's caught by a
        # different code path. We're only after the "treats it as an
        # object with named fields" misuse that triggered May-22.
        local SAFE_METHODS="indexOf includes forEach map filter slice length push pop shift unshift join concat splice find findIndex some every reduce sort reverse keys values entries hasOwnProperty toString"
        local j end=$((i + 3))
        [ $end -ge $n ] && end=$((n - 1))
        local found_line=""
        local found_prop=""
        for (( j = i + 1; j <= end; j++ )); do
            local nxt="${LINES[$j]}"
            case "$nxt" in
                *"unwrapPbJson"*"("*"$var"*) break ;;
                *"toJsArray("*"$var"*) break ;;
                *"toPlainObject("*"$var"*) break ;;
            esac
            # `for (... in <var>)` — object-key iteration. Implies the
            # caller thinks `<var>` is an object with string keys, which
            # silently no-ops on a goja-wrapped byte array.
            if [[ "$nxt" =~ for[[:space:]]*\([^\)]*[[:space:]]+in[[:space:]]+${var}[^a-zA-Z0-9_$] ]]; then
                found_line="$((j + 1))"
                found_prop="(for...in)"
                break
            fi
            # `<var>.<ident>` (dot-access).
            if [[ "$nxt" =~ (^|[^a-zA-Z0-9_$])${var}\.([a-zA-Z_$][a-zA-Z0-9_$]*) ]]; then
                local prop="${BASH_REMATCH[2]}"
                # Skip safe methods/properties.
                local is_safe=""
                for m in $SAFE_METHODS; do
                    if [ "$prop" = "$m" ]; then is_safe="1"; break; fi
                done
                [ -n "$is_safe" ] && continue
                found_line="$((j + 1))"
                found_prop="$prop"
                break
            fi
        done

        if [ -n "$found_line" ]; then
            emit "$file" "$((i + 1))" \
                "raw .get(\"$field\") → property read \`$var.$found_prop\` at $file:$found_line without unwrapPbJson" \
                "wrap with unwrapPbJson() from lib/pb-json.js, or append // lint-skip: <reason>"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    done
}

# Drive both checks across every non-allowlisted file.
SCANNED=0
ALLOWLISTED=0
while IFS= read -r file; do
    if is_allowlisted "$file"; then
        ALLOWLISTED=$((ALLOWLISTED + 1))
        continue
    fi
    SCANNED=$((SCANNED + 1))
    check_round_trip_after_get "$file"
    check_unwrapped_json_field_access "$file"
done < <(collect_files)

echo ""
echo "lint-pb-migrations: scanned $SCANNED file(s), allowlisted $ALLOWLISTED frozen migration(s), $SKIP_COUNT // lint-skip annotation(s)"

if [ "$FAIL_COUNT" -gt 0 ]; then
    echo "lint-pb-migrations: FAIL — $FAIL_COUNT finding(s)" >&2
    exit 1
fi

echo "lint-pb-migrations: OK"
exit 0
