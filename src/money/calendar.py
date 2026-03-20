"""Google Calendar integration — fetches events and detects trips."""

import logging
from datetime import date, datetime, timedelta
from typing import Any, cast

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from money.config import CONFIG_DIR

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]
CREDENTIALS_FILE = CONFIG_DIR / "google_credentials.json"
TOKEN_FILE = CONFIG_DIR / "google_token.json"
TRAVEL_CALENDAR_ID = "5t30nqbr366g1oekufagg18ugg@group.calendar.google.com"


def _get_credentials() -> Credentials:
    """Get or refresh Google OAuth credentials."""
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        if creds.valid:
            return creds
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            _save_credentials(creds)
            return creds

    if not CREDENTIALS_FILE.exists():
        raise FileNotFoundError(
            f"No credentials at {CREDENTIALS_FILE}. "
            "Download OAuth client JSON from Google Cloud Console."
        )
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
    result = flow.run_local_server(
        port=8085, open_browser=False, bind_addr="0.0.0.0",
    )
    # run_local_server returns a union; we need google.oauth2.credentials.Credentials
    if not isinstance(result, Credentials):
        raise TypeError(f"Expected Credentials, got {type(result)}")
    _save_credentials(result)
    return result


def _save_credentials(creds: Credentials) -> None:
    """Persist credentials to disk."""
    TOKEN_FILE.write_text(str(creds.to_json()))


def _build_service() -> Any:
    """Build an authenticated Calendar API service."""
    creds = _get_credentials()
    return cast(Any, build("calendar", "v3", credentials=creds))


def auth() -> None:
    """Run the OAuth flow interactively and save the token."""
    _get_credentials()
    log.info("Google Calendar auth complete. Token saved to %s", TOKEN_FILE)


def fetch_events(
    start: date | None = None,
    end: date | None = None,
    calendar_id: str = "primary",
) -> list[dict[str, Any]]:
    """Fetch calendar events in a date range.

    Returns list of event dicts with: summary, start, end, location, all_day.
    """
    service = _build_service()

    if start is None:
        start = date.today() - timedelta(days=365 * 2)
    if end is None:
        end = date.today() + timedelta(days=30)

    time_min = datetime(start.year, start.month, start.day).isoformat() + "Z"
    time_max = datetime(end.year, end.month, end.day).isoformat() + "Z"

    events: list[dict[str, Any]] = []
    page_token: str | None = None

    while True:
        result = service.events().list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
            maxResults=2500,
            pageToken=page_token,
        ).execute()

        for item in result.get("items", []):
            start_raw = item.get("start", {})
            end_raw = item.get("end", {})

            # All-day events use "date", timed events use "dateTime"
            all_day = "date" in start_raw
            if all_day:
                event_start = date.fromisoformat(start_raw["date"])
                event_end = date.fromisoformat(end_raw["date"])
            else:
                event_start = datetime.fromisoformat(
                    start_raw["dateTime"]
                ).date()
                event_end = datetime.fromisoformat(
                    end_raw["dateTime"]
                ).date()

            events.append({
                "summary": item.get("summary", "(no title)"),
                "start": event_start.isoformat(),
                "end": event_end.isoformat(),
                "location": item.get("location"),
                "all_day": all_day,
                "duration_days": (event_end - event_start).days,
            })

        page_token = result.get("nextPageToken")
        if not page_token:
            break

    log.info("Fetched %d events from %s to %s", len(events), start, end)
    return events


def detect_trips(
    start: date | None = None,
    end: date | None = None,
    home_city: str = "Sacramento",
) -> list[dict[str, Any]]:
    """Detect trips from calendar events.

    Uses the dedicated Travel calendar as the primary source.
    Falls back to the primary calendar for periods not covered
    by the Travel calendar.
    """
    if start is None:
        start = date.today() - timedelta(days=365)
    if end is None:
        end = date.today() + timedelta(days=30)

    # 1. Get trips from the Travel calendar (these are authoritative)
    travel_events = fetch_events(start=start, end=end, calendar_id=TRAVEL_CALENDAR_ID)

    trips: list[dict[str, Any]] = []
    skip_keywords = ["short cut", "haircut", "barber", "pt"]

    for event in travel_events:
        summary = event["summary"]
        if any(kw in summary.lower() for kw in skip_keywords):
            continue
        if event["duration_days"] < 1:
            continue

        trips.append({
            "name": summary,
            "start": event["start"],
            "end": event["end"],
            "duration_days": event["duration_days"],
            "location": event.get("location"),
        })

    # 2. Find gaps in Travel calendar coverage and fill from primary calendar
    travel_end = date.fromisoformat(max(t["end"] for t in trips)) if trips else start
    if travel_end < end:
        primary_events = fetch_events(start=travel_end, end=end, calendar_id="primary")
        travel_keywords = [
            "trip", "travel", "vacation", "flight", "hotel",
            "airbnb", "visiting", "getaway", "retreat", "stay at",
        ]

        for event in primary_events:
            summary_lower = event["summary"].lower()
            location = (event.get("location") or "").lower()
            duration = event["duration_days"]

            is_trip = False

            if event["all_day"] and duration >= 2:
                work_keywords = [
                    "sprint", "meeting", "standup", "oncall", "on-call",
                    "birthday", "anniversary", "deadline", "review",
                    "holiday", "pto", "ooo",
                ]
                if not any(kw in summary_lower for kw in work_keywords):
                    is_trip = True

            if any(kw in summary_lower for kw in travel_keywords):
                is_trip = True

            if location and home_city.lower() not in location and duration >= 1:
                is_trip = True

            if is_trip:
                trips.append({
                    "name": event["summary"],
                    "start": event["start"],
                    "end": event["end"],
                    "duration_days": duration,
                    "location": event.get("location"),
                })

    # Merge overlapping and nearby events into trips.
    # Events within gap_days of each other are considered part of the same trip.
    gap_days = 2
    trips.sort(key=lambda t: t["start"])
    merged: list[dict[str, Any]] = []
    for trip in trips:
        trip_start = date.fromisoformat(trip["start"])
        if merged:
            prev_end = date.fromisoformat(merged[-1]["end"])
            if trip_start <= prev_end + timedelta(days=gap_days):
                # Extend the existing trip
                prev = merged[-1]
                trip_end = date.fromisoformat(trip["end"])
                if trip_end > prev_end:
                    prev["end"] = trip["end"]
                prev["duration_days"] = (
                    date.fromisoformat(prev["end"]) - date.fromisoformat(prev["start"])
                ).days
                # Collect all locations
                if trip.get("location"):
                    prev.setdefault("locations", [])
                    prev["locations"].append(trip["location"])
                # Pick a good name: prefer non-flight names
                if "flight" not in trip["name"].lower() and (
                    "flight" in prev["name"].lower()
                    or len(trip["name"]) > len(prev["name"])
                ):
                    prev["name"] = trip["name"]
                continue
        merged.append(dict(trip))

    # Derive destination from locations (pick the non-home location)
    for trip in merged:
        locations = trip.pop("locations", [])
        if trip.get("location"):
            locations.insert(0, trip["location"])
        # Find a destination (not home city)
        destinations = [
            loc for loc in locations
            if home_city.lower() not in loc.lower()
        ]
        if destinations:
            trip["location"] = destinations[0]
        elif locations:
            trip["location"] = locations[0]

        # Clean up flight-based names
        name = trip["name"]
        if name.startswith("Flight to") and trip.get("location"):
            # Use destination instead
            loc = trip["location"]
            # Extract city name from location string
            city = loc.split(",")[0].strip()
            trip["name"] = city

    # Clean up trip names and filter out non-trips
    for trip in merged:
        trip["name"] = _clean_trip_name(trip["name"], trip.get("location"))

    # Remove "trips" to home city
    merged = [t for t in merged if t["name"].lower() != home_city.lower()]

    log.info("Detected %d trips", len(merged))
    return merged


def _clean_trip_name(name: str, location: str | None) -> str:
    """Derive a short, readable trip name from calendar event name + location."""
    # Strip prefix conventions like "SK) " or "AC) "
    if len(name) > 3 and name[2:4] == ") ":
        name = name[4:]

    # "Stay at <Hotel Name>" → extract city from location or hotel name
    if name.lower().startswith("stay at "):
        name = name[8:]
        if location:
            city = _city_from_location(location)
            if city:
                return city
        # Try to extract city from hotel name
        for keyword in ["San Francisco", "Sacramento", "Calistoga", "Muncie",
                        "Indianapolis", "Las Vegas", "Los Angeles", "Portland",
                        "Seattle", "Denver", "Chicago", "New York"]:
            if keyword.lower() in name.lower():
                return keyword
        # Just use the hotel name but truncate
        return name.split(",")[0][:30]

    # "Flight to X (XX 1234)" → skip, these should have been merged
    if name.lower().startswith("flight to"):
        if location:
            city = _city_from_location(location)
            if city:
                return city
        return name

    # Airport codes like "Burbank BUR" → map to city
    airport_cities: dict[str, str] = {
        "BUR": "LA", "LAX": "LA", "SNA": "LA", "LGB": "LA",
        "SFO": "SF", "OAK": "SF", "SJC": "SF",
        "SMF": "Sacramento",
        "SEA": "Seattle", "PDX": "Portland",
        "ORD": "Chicago", "MDW": "Chicago",
        "IND": "Indianapolis",
        "DEN": "Denver",
        "LAS": "Las Vegas",
        "JFK": "NYC", "LGA": "NYC", "EWR": "NYC",
        "DFW": "Dallas",
    }
    for code, city in airport_cities.items():
        if name.endswith(f" {code}"):
            return city

    # "Enterprise Rent-A-Car Reservation #..." → use location
    if "rent-a-car" in name.lower() or "reservation" in name.lower():
        if location:
            city = _city_from_location(location)
            if city:
                return city
        return "Road Trip"

    return name


def _city_from_location(location: str) -> str | None:
    """Extract a city name from a Google Calendar location string."""
    # Common patterns: "Hotel Name, City" or "Address, City, State ZIP"
    parts = [p.strip() for p in location.split(",")]
    if len(parts) >= 2:
        # Skip the first part (usually venue/address), take the city
        candidate = parts[1].strip()
        # If it looks like a state abbreviation or zip, go back one
        if len(candidate) <= 3 or candidate.replace(" ", "").isdigit():
            candidate = parts[0].strip()
        # Strip "Pick-up: " etc.
        for prefix in ["Pick-up: ", "Return: "]:
            if candidate.startswith(prefix):
                candidate = candidate[len(prefix):]
        return candidate
    return None


def match_transactions_to_trips(
    trips: list[dict[str, Any]],
    transactions: list[dict[str, Any]],
    booking_window_days: int = 60,
) -> dict[str, list[dict[str, Any]]]:
    """Match travel transactions to detected trips.

    For each transaction, find the best matching trip:
    1. If the transaction date falls within a trip's date range, match it.
    2. If it's a flight/hotel booked in advance, look for the nearest
       upcoming trip within booking_window_days.
    3. Unmatched transactions go into an "Other Travel" bucket.

    Returns dict of trip_name -> list of transactions.
    """
    advance_booking_patterns = [
        "airline", "united air", "southwest", "alaska air", "american air",
        "jetblue", "airbnb", "vrbo", "hotel", "hyatt", "hilton", "marriott",
        "travel insurance", "enterprise", "hertz",
    ]

    # Use index-based keys to handle duplicate trip names
    result: dict[int, list[dict[str, Any]]] = {i: [] for i in range(len(trips))}
    other: list[dict[str, Any]] = []

    for txn in transactions:
        txn_date = date.fromisoformat(txn["date"])
        desc_lower = (txn.get("description") or "").lower()

        # 1. Direct date match — find the best (shortest) trip containing this date
        best_idx: int | None = None
        best_duration = 9999
        for i, trip in enumerate(trips):
            trip_start = date.fromisoformat(trip["start"])
            trip_end = date.fromisoformat(trip["end"])
            # Allow 1 day buffer on each side
            if (trip_start - timedelta(days=1) <= txn_date <= trip_end + timedelta(days=1)
                    and trip["duration_days"] < best_duration):
                best_idx = i
                best_duration = trip["duration_days"]

        if best_idx is not None:
            result[best_idx].append(txn)
            continue

        # 2. Advance booking match — find nearest upcoming trip
        txn_category = (txn.get("category") or "").lower()
        is_booking = (
            any(pat in desc_lower for pat in advance_booking_patterns)
            or txn_category in ("airfare", "lodging", "car rental", "other travel")
        )
        if is_booking:
            best_idx = None
            best_distance = booking_window_days + 1
            for i, trip in enumerate(trips):
                trip_start = date.fromisoformat(trip["start"])
                distance = (trip_start - txn_date).days
                if 0 < distance <= booking_window_days and distance < best_distance:
                    best_idx = i
                    best_distance = distance

            if best_idx is not None:
                result[best_idx].append(txn)
                continue

        # 3. Unmatched
        other.append(txn)

    # Convert to name-based dict, adding date suffix for duplicate names
    named: dict[str, list[dict[str, Any]]] = {}
    for i, txns in result.items():
        if not txns:
            continue
        name = trips[i]["name"]
        # Add date to disambiguate duplicate trip names
        key = f"{name} ({trips[i]['start'][:7]})"
        named[key] = txns

    named["Other Travel"] = other
    return named
