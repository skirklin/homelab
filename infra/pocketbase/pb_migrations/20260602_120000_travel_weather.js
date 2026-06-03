/// <reference path="../pb_data/types.d.ts" />

/**
 * Persisted per-day weather for trips.
 *
 * One row per (trip, date) holding the weather that day — forecast for
 * upcoming days, recorded actuals for past days. The API (services/api,
 * GET /fn/travel/weather) backfills past days from Open-Meteo's
 * forecast/archive APIs via the superuser client and serves the merged span
 * so the itinerary stays a complete weather record after the trip is over.
 *
 * Reads are owner-of-log (mirrors travel_day_entries); writes are
 * superuser-only — the collection is filled exclusively by the API via
 * getAdminPb(), never by clients. No JSON columns, so unwrapPbJson isn't
 * needed.
 */

migrate(
  (app) => {
    try {
      app.findCollectionByNameOrId("travel_weather");
      console.log("  travel_weather: already exists, skipping");
      return;
    } catch {
      // create below
    }

    const logs = app.findCollectionByNameOrId("travel_logs");
    const trips = app.findCollectionByNameOrId("travel_trips");

    // Owner-of-log rule, mirroring other travel collections.
    const ownerRule = '@request.auth.id != "" && @request.auth.id ?= log.owners.id';

    const col = new Collection({
      type: "base",
      name: "travel_weather",
      listRule: ownerRule,
      viewRule: ownerRule,
      // Superuser-only writes: the API is the sole writer (via getAdminPb).
      createRule: null,
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "log",
          collectionId: logs.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        {
          type: "relation",
          name: "trip",
          collectionId: trips.id,
          maxSelect: 1,
          required: true,
          cascadeDelete: true,
        },
        // YYYY-MM-DD; matches ItineraryDay.date and DailyForecast.date.
        { type: "text", name: "date", required: true, max: 10 },
        { type: "number", name: "tempMaxF" },
        { type: "number", name: "tempMinF" },
        { type: "number", name: "precipMm" },
        { type: "number", name: "precipProbabilityMax" },
        { type: "number", name: "windMphMax" },
        { type: "number", name: "uvIndexMax" },
        { type: "number", name: "weatherCode" },
        { type: "text", name: "source", max: 16 },
        { type: "number", name: "lat" },
        { type: "number", name: "lon" },
        { type: "text", name: "capturedAt", max: 32 },
      ],
      indexes: [
        // One row per trip+date.
        "CREATE UNIQUE INDEX idx_travel_weather_trip_date ON travel_weather (trip, date)",
        "CREATE INDEX idx_travel_weather_log ON travel_weather (log)",
      ],
    });

    app.save(col);
    console.log("  travel_weather: created");
  },
  (app) => {
    try {
      const col = app.findCollectionByNameOrId("travel_weather");
      app.delete(col);
    } catch {
      // already gone
    }
  }
);
