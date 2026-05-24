/// <reference path="../pb_data/types.d.ts" />

// HISTORICAL NOTE: this migration corrupted sessions + lost composite-
// trackable data on 2026-05-23 because it didn't use unwrapPbJson() to
// handle PB's []byte JSON storage form in goja. The defensive JSON
// round-trip below (`JSON.parse(JSON.stringify(r.get("data") || {}))`)
// turns a Go []byte JSON column into a JS array of byte numbers, not a
// parsed object — so per-subject mapRow branches saw arrays instead of
// objects. Sessions retained the byte array as `entries` (recoverable
// via char-code decode); composite trackables (sleep/exercise/work/
// symptoms/mood/content) produced empty entries (recovery via the
// pre-migration PB backup). Recovery via
// services/scripts/historical/recover-life-events.ts. The future migration template
// should always use unwrapPbJson() — see
// infra/pocketbase/pb_migrations/lib/pb-json.js.

/**
 * life_events: unify the row shape behind a single `entries` array.
 *
 * Before: every row had a free-form `data` JSON blob with hidden per-`subject_id`
 * conventions (e.g. sleep used `{hours, quality, notes}`, exercise used
 * `{hours, intensity, category}`, sessions used arbitrary prompt-keyed fields,
 * counters used `{}` or `{count: 1}`, etc.). All readers had to know each
 * subject's data shape, and the legacy adapter (apps/life/.../legacy-adapter.ts)
 * was getting hairy as the historical conventions accumulated.
 *
 * After: rows have three uniform fields:
 *
 *   - `entries`: Array<Entry> — bag of named typed values captured during the
 *     event. Each Entry is either:
 *       { name, type: "number", value, unit, scale? }   // e.g. duration in min, dose in mg, rating 4/5
 *       { name, type: "text",   value }                 // e.g. journal body, session prompt answers
 *
 *   - `labels`: Record<string,string> | null — k8s-style categorical
 *     dimensions. Conventions:
 *       source: "manual" | "sample" | "journey" | "wearable" | "import"
 *       category: free-form per subject (replaces old data.category)
 *       tz: IANA timezone of the logger at write time
 *       journey_id: foreign key for Journey backfill idempotency
 *       weather/location_*: Journey-era enrichment (lat/lon serialize as strings)
 *
 *   - `end_time`: ISO timestamp | null — for intervals (sleep, workouts).
 *     Unused today; reserved so the schema doesn't need another migration when
 *     timer-style logging lands.
 *
 * Canonical units (stored as-is; UI formats for display):
 *   "min"     — durations (sleep, exercise, focus) — 8h sleep is value=480, unit=min
 *   "mg"      — doses (vyvanse, ibuprofin, edibles)
 *   "oz"      — volumes (coffee)
 *   "drinks"  — count of alcoholic drinks
 *   "ct"      — count of discrete things (vitamins, floss, poop, sex, etc.)
 *   "rating"  — 1..scale rating; companion `scale` field (default 5)
 *
 * Aggregation behaviour is derived from unit (see apps/life/.../format.ts):
 * ratings average, everything else sums. The old `Trackable.aggregation`
 * declaration is dropped in the same commit train as this migration.
 *
 * The down() side is a courtesy. Reconstructing the old `data` blob is
 * best-effort — some shape information will be lost on round-trip (e.g. the
 * Entry/labels split for journal rows). Don't rely on it for production
 * rollback; rely on a PB backup.
 */

// ---------------------------------------------------------------------------
// Module-scope helpers can't be reached from inside the migrate() callback
// (goja sharp edge per feedback_pb_goja_sharp_edges). Everything below is a
// reference for humans; the actual mapping is inlined in up().
// ---------------------------------------------------------------------------

migrate(
  (app) => {
    // -----------------------------------------------------------------------
    // 1. Add the new columns alongside the existing `data` column.
    // -----------------------------------------------------------------------
    const col = app.findCollectionByNameOrId("life_events");
    const additions = [
      { type: "date", name: "end_time" },
      { type: "json", name: "entries", maxSize: 50000 },
      { type: "json", name: "labels", maxSize: 10000 },
    ];
    for (const f of additions) {
      if (!col.fields.getByName(f.name)) {
        col.fields.add(new Field(f));
        console.log(`  life_events: added ${f.name}`);
      }
    }
    app.save(col);

    // -----------------------------------------------------------------------
    // 2. Rewrite every existing row in place.
    //
    // Inline tables — goja closures can't reach module-scope helpers. Edit
    // both copies if the manifest changes (it shouldn't; sessions rarely
    // gain prompts).
    // -----------------------------------------------------------------------

    // Session prompts: subject_id -> { promptId -> type } where type is one
    // of "text" | "rating" | "number" | "checkbox". Maps an answer field in
    // the legacy `data` blob into an Entry. Mirrors apps/life/.../manifest.ts.
    const SESSION_PROMPT_TYPES = {
      morning_session: {
        gratitude: "text",
        intention: "text",
        energy: "rating",
      },
      evening_session: {
        win: "text",
        lesson: "text",
        mood: "rating",
      },
      weekly_review_session: {
        highlights: "text",
        lows: "text",
        lesson: "text",
        intention: "text",
        mood_rating: "rating",
      },
    };

    // Default dose per medical/consumable subject — used when the legacy row
    // had `data: {}` (or no `value`/`amount`) and we still need a sensible
    // entry to write. Mirrors `defaultValue` in apps/life/.../manifest.ts.
    const DOSE_DEFAULTS = {
      vyvanse: { value: 30, unit: "mg", name: "dose" },
      ibuprofin: { value: 400, unit: "mg", name: "dose" },
      edibles: { value: 5, unit: "mg", name: "dose" },
      alcohol: { value: 1, unit: "drinks", name: "drinks" },
      coffee: { value: 8, unit: "oz", name: "volume" },
    };

    // Plain-count subjects: each row counts as 1 unless data.count is set.
    const COUNT_SUBJECTS = {
      vitamins: "ct",
      floss: "ct",
      poop: "ct",
      wank: "ct",
      sex: "ct",
    };

    // Rating-singleton subjects: data.value (or data.<id>) is the rating.
    const RATING_SUBJECTS = {
      mood: true,
      content: true,
      sleep_quality: true,
      energy: true, // legacy __sample__ fan-out target
    };

    function pickNumber(obj, key) {
      if (!obj) return undefined;
      const v = obj[key];
      return typeof v === "number" ? v : undefined;
    }

    function pickString(obj, key) {
      if (!obj) return undefined;
      const v = obj[key];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    }

    function mapRow(subjectId, raw) {
      // `raw` is the legacy data blob (already unwrapped via JSON round-trip).
      const data = raw || {};
      const entries = [];
      const labels = {};

      // Default source = manual; overridden by data.source if present.
      const src = pickString(data, "source");
      labels.source = src ? src : "manual";

      // Per-subject mapping.
      if (subjectId === "sleep") {
        // {hours, quality, notes?} -> duration entry (min) + quality entry (rating)
        // New shape (already-converted rows): {value (min), notes?, ...} -> just keep duration entry.
        const hours = pickNumber(data, "hours");
        const value = pickNumber(data, "value"); // post-collapse shape stored minutes directly
        if (hours !== undefined) {
          entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
        } else if (value !== undefined) {
          entries.push({ name: "duration", type: "number", value: value, unit: "min" });
        }
        const quality = pickNumber(data, "quality");
        if (quality !== undefined) {
          entries.push({ name: "quality", type: "number", value: quality, unit: "rating", scale: 5 });
        }
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (subjectId === "exercise") {
        const hours = pickNumber(data, "hours");
        const value = pickNumber(data, "value");
        if (hours !== undefined) {
          entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
        } else if (value !== undefined) {
          entries.push({ name: "duration", type: "number", value: value, unit: "min" });
        }
        const intensity = pickNumber(data, "intensity");
        if (intensity !== undefined) {
          entries.push({ name: "intensity", type: "number", value: intensity, unit: "rating", scale: 5 });
        }
        const category = pickString(data, "category");
        if (category) labels.category = category;
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (subjectId === "focus") {
        const hours = pickNumber(data, "hours");
        const value = pickNumber(data, "value");
        if (hours !== undefined) {
          entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
        } else if (value !== undefined) {
          entries.push({ name: "duration", type: "number", value: value, unit: "min" });
        }
        const category = pickString(data, "category");
        if (category) labels.category = category;
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (subjectId === "work") {
        // dead but historical: {hours, quality} -> duration min + quality rating
        const hours = pickNumber(data, "hours");
        if (hours !== undefined) {
          entries.push({ name: "duration", type: "number", value: Math.round(hours * 60), unit: "min" });
        }
        const quality = pickNumber(data, "quality");
        if (quality !== undefined) {
          entries.push({ name: "quality", type: "number", value: quality, unit: "rating", scale: 5 });
        }
      } else if (subjectId === "symptoms") {
        // dead but historical: every numeric field becomes a rating entry.
        for (const k in data) {
          if (k === "notes" || k === "source") continue;
          const v = data[k];
          if (typeof v === "number") {
            entries.push({ name: k, type: "number", value: v, unit: "rating", scale: 5 });
          }
        }
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (subjectId === "freeform_journal" || subjectId === "journal") {
        // Journey backfill (current shape: text + tags/location/weather/mood
        // in data). Move them all into entries (text) and labels (k/v).
        const text = pickString(data, "text");
        if (text) entries.push({ name: "body", type: "text", value: text });
        const mood = pickNumber(data, "mood");
        if (mood !== undefined) {
          entries.push({ name: "mood", type: "number", value: mood, unit: "rating", scale: 5 });
        }
        const jid = pickString(data, "journey_id");
        if (jid) labels.journey_id = jid;
        const tz = pickString(data, "timezone");
        if (tz) labels.tz = tz;
        if (data.location && typeof data.location === "object") {
          const lat = pickNumber(data.location, "lat");
          const lon = pickNumber(data.location, "lon");
          if (lat !== undefined) labels.location_lat = String(lat);
          if (lon !== undefined) labels.location_lon = String(lon);
          const addr = pickString(data.location, "address");
          if (addr) labels.location_address = addr;
        }
        if (data.weather && typeof data.weather === "object") {
          const desc = pickString(data.weather, "description");
          if (desc) labels.weather = desc;
          const place = pickString(data.weather, "place");
          if (place) labels.weather_place = place;
          const degC = pickNumber(data.weather, "degree_c");
          if (degC !== undefined) labels.weather_degree_c = String(degC);
        }
        if (data.music && typeof data.music === "object") {
          const mt = pickString(data.music, "title");
          if (mt) labels.music_title = mt;
          const ma = pickString(data.music, "artist");
          if (ma) labels.music_artist = ma;
        }
        if (data.favourite === true) labels.favourite = "true";
        if (Array.isArray(data.tags) && data.tags.length > 0) {
          // Flatten to a comma-separated string so it survives string labels.
          const tagStrs = [];
          for (let i = 0; i < data.tags.length; i++) {
            if (typeof data.tags[i] === "string") tagStrs.push(data.tags[i]);
          }
          if (tagStrs.length > 0) labels.tags = tagStrs.join(",");
        }
        labels.source = src || "journey";
      } else if (
        subjectId === "morning_session" ||
        subjectId === "evening_session" ||
        subjectId === "weekly_review_session"
      ) {
        const promptMap = SESSION_PROMPT_TYPES[subjectId];
        for (const promptId in promptMap) {
          const v = data[promptId];
          const ptype = promptMap[promptId];
          if (v === undefined || v === null || v === "") continue;
          if (ptype === "text" && typeof v === "string") {
            entries.push({ name: promptId, type: "text", value: v });
          } else if (ptype === "rating" && typeof v === "number") {
            entries.push({ name: promptId, type: "number", value: v, unit: "rating", scale: 5 });
          } else if (ptype === "number" && typeof v === "number") {
            entries.push({ name: promptId, type: "number", value: v, unit: "ct" });
          } else if (ptype === "checkbox") {
            // Booleans stored as 1/0 in the unit "ct" so they participate in
            // a single numeric type.
            entries.push({ name: promptId, type: "number", value: v ? 1 : 0, unit: "ct" });
          }
        }
        // Catch any unknown extra fields as text — better than dropping them.
        for (const k in data) {
          if (promptMap[k] !== undefined) continue;
          if (k === "source" || k === "notes") continue;
          const v = data[k];
          if (typeof v === "string") {
            entries.push({ name: k, type: "text", value: v });
          } else if (typeof v === "number") {
            entries.push({ name: k, type: "number", value: v, unit: "ct" });
          }
        }
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (RATING_SUBJECTS[subjectId]) {
        // mood/content/sleep_quality/energy: one rating entry.
        const value = pickNumber(data, "value");
        if (value !== undefined) {
          entries.push({ name: "rating", type: "number", value: value, unit: "rating", scale: 5 });
        }
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (DOSE_DEFAULTS[subjectId]) {
        const def = DOSE_DEFAULTS[subjectId];
        const v = pickNumber(data, "value");
        const amount = pickNumber(data, "amount");
        const value = v !== undefined ? v : (amount !== undefined ? amount : def.value);
        entries.push({ name: def.name, type: "number", value: value, unit: def.unit });
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (COUNT_SUBJECTS[subjectId]) {
        const unit = COUNT_SUBJECTS[subjectId];
        const count = pickNumber(data, "count");
        const value = pickNumber(data, "value");
        const final = count !== undefined ? count : (value !== undefined ? value : 1);
        entries.push({ name: "count", type: "number", value: final, unit: unit });
        const notes = pickString(data, "notes");
        if (notes) entries.push({ name: "notes", type: "text", value: notes });
      } else if (subjectId === "__sample__") {
        // Legacy random-sample fan-out. Each numeric key was a per-question
        // rating. We fan out to N rows by returning a signal — handled in the
        // main loop below (mapRow returns a single row; the loop will detect
        // sample rows and split them).
        // For mapRow's contract, return the row as-is with no entries; the
        // outer loop will rewrite it.
      } else {
        // Unknown subject — preserve numbers as ct, strings as text.
        for (const k in data) {
          if (k === "source") continue;
          const v = data[k];
          if (typeof v === "number") {
            entries.push({ name: k, type: "number", value: v, unit: "ct" });
          } else if (typeof v === "string") {
            entries.push({ name: k, type: "text", value: v });
          }
        }
      }

      return { entries: entries, labels: labels };
    }

    // -----------------------------------------------------------------------
    // Iterate and rewrite.
    // -----------------------------------------------------------------------
    const rows = app.findRecordsByFilter("life_events", "1=1");
    let rewritten = 0;
    let fannedOut = 0;
    let unmapped = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const subjectId = r.get("subject_id") || "";
      // Defensive JSON round-trip — goja-wrapped objects can't be iterated
      // cleanly. This produces a pure JS object.
      let raw;
      try {
        raw = JSON.parse(JSON.stringify(r.get("data") || {}));
      } catch (e) {
        raw = {};
      }

      // Special-case __sample__: fan out to per-question rows.
      if (subjectId === "__sample__") {
        const SAMPLE_KEYS = ["mood", "content", "energy", "sleep_quality"];
        const ts = r.get("timestamp");
        const log = r.get("log");
        const createdBy = r.get("created_by");
        const newRows = [];
        for (let k = 0; k < SAMPLE_KEYS.length; k++) {
          const key = SAMPLE_KEYS[k];
          const v = raw[key];
          if (typeof v !== "number") continue;
          newRows.push({
            key: key,
            value: v,
          });
        }
        if (newRows.length === 0) {
          // No usable answers; delete the row (lose-nothing reasoning: a
          // sample row with no numeric answers is content-less).
          app.delete(r);
          continue;
        }
        // First answer reuses the original record (preserves id continuity).
        const first = newRows[0];
        r.set("subject_id", first.key);
        r.set("entries", [{ name: "rating", type: "number", value: first.value, unit: "rating", scale: 5 }]);
        r.set("labels", { source: "sample" });
        r.set("data", null);
        app.save(r);
        rewritten++;
        // Extra answers become new rows with the same timestamp + log + creator.
        for (let k = 1; k < newRows.length; k++) {
          const extra = newRows[k];
          const newRec = new Record(r.collection());
          newRec.set("log", log);
          newRec.set("subject_id", extra.key);
          newRec.set("timestamp", ts);
          newRec.set("created_by", createdBy);
          newRec.set("entries", [{ name: "rating", type: "number", value: extra.value, unit: "rating", scale: 5 }]);
          newRec.set("labels", { source: "sample" });
          app.save(newRec);
          fannedOut++;
        }
        continue;
      }

      const mapped = mapRow(subjectId, raw);
      r.set("entries", mapped.entries);
      r.set("labels", Object.keys(mapped.labels).length > 0 ? mapped.labels : null);
      // Clear `data` now — we'll drop the column at the end. Leaving it
      // populated would just bloat the DB.
      r.set("data", null);
      if (mapped.entries.length === 0) unmapped++;
      app.save(r);
      rewritten++;
    }
    console.log(`  life_events: rewrote ${rewritten} rows (+${fannedOut} fanned-out from __sample__, ${unmapped} with empty entries)`);

    // -----------------------------------------------------------------------
    // 3. Drop the legacy `data` column.
    // -----------------------------------------------------------------------
    const col2 = app.findCollectionByNameOrId("life_events");
    const dataField = col2.fields.getByName("data");
    if (dataField) {
      col2.fields.removeById(dataField.id);
      app.save(col2);
      console.log(`  life_events: dropped data column`);
    }
  },
  (app) => {
    // -----------------------------------------------------------------------
    // Down: best-effort. Reconstruct a `data` blob from entries+labels, then
    // drop the new columns. Some original shape will be lost on round-trip
    // (e.g. journal labels collapse back into top-level data fields without
    // their nested structure). Use a PB backup for production rollback.
    // -----------------------------------------------------------------------
    const col = app.findCollectionByNameOrId("life_events");
    if (!col.fields.getByName("data")) {
      col.fields.add(new Field({ type: "json", name: "data", maxSize: 50000 }));
      app.save(col);
    }

    const rows = app.findRecordsByFilter("life_events", "1=1");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      let entries;
      let labels;
      try {
        entries = JSON.parse(JSON.stringify(r.get("entries") || []));
      } catch (e) {
        entries = [];
      }
      try {
        labels = JSON.parse(JSON.stringify(r.get("labels") || {}));
      } catch (e) {
        labels = {};
      }

      const data = {};
      for (let j = 0; j < entries.length; j++) {
        const e = entries[j];
        if (!e || typeof e !== "object" || typeof e.name !== "string") continue;
        // For numeric unit=min, store back as `value` (no hours conversion —
        // not worth the precision loss); for ratings, store as the entry name.
        data[e.name] = e.value;
      }
      for (const k in labels) {
        if (k === "source") {
          data.source = labels[k];
        } else if (data[k] === undefined) {
          // Don't clobber an entry field with a label of the same name.
          data[k] = labels[k];
        }
      }
      r.set("data", data);
      app.save(r);
    }

    const col2 = app.findCollectionByNameOrId("life_events");
    for (const name of ["entries", "labels", "end_time"]) {
      const f = col2.fields.getByName(name);
      if (f) col2.fields.removeById(f.id);
    }
    app.save(col2);
  }
);
