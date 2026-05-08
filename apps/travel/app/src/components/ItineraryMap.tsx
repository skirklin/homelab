/// <reference types="google.maps" />
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import {
  APIProvider,
  Map as GoogleMap,
  AdvancedMarker,
  InfoWindow,
  useMap,
} from "@vis.gl/react-google-maps";
import { Tag, Typography } from "antd";
import {
  EnvironmentOutlined,
  ClockCircleOutlined,
  DollarOutlined,
  HomeOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
// Google Maps API key from env
import type { Activity, Itinerary } from "../types";

const MAP_ID = "travel-map";

// Day colors — enough for a 2-week trip
const DAY_COLORS = [
  "#1677ff", "#52c41a", "#fa8c16", "#eb2f96", "#722ed1",
  "#13c2c2", "#fa541c", "#2f54eb", "#a0d911", "#f5222d",
  "#597ef7", "#36cfc9", "#ffc53d", "#ff7a45",
];

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const MapWrapper = styled.div`
  height: 500px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #f0f0f0;
`;

const InfoContent = styled.div`
  max-width: 240px;
  font-size: 12px;
`;

const InfoTitle = styled.div`
  font-weight: 600;
  font-size: 13px;
  margin-bottom: 4px;
`;

const InfoMeta = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: #595959;
`;

const InfoRow = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`;

// Dashed flight segment between two airports.
// Uses a geodesic polyline so it follows the great circle (correct for long flights).
function FlightSegment({ from, to, color }: {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  color: string;
}) {
  const map = useMap(MAP_ID);
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map) return;
    polylineRef.current?.setMap(null);
    const polyline = new google.maps.Polyline({
      path: [from, to],
      geodesic: true,
      strokeColor: color,
      strokeOpacity: 0,
      icons: [{
        icon: { path: "M 0,-1 0,1", strokeOpacity: 0.8, scale: 3 },
        offset: "0",
        repeat: "10px",
      }],
      strokeWeight: 2,
      map,
    });
    polylineRef.current = polyline;
    return () => { polyline.setMap(null); };
  }, [map, from.lat, from.lng, to.lat, to.lng, color]);

  return null;
}

// Small plane-at-airport marker
function FlightMarker({ color, label }: { color: string; label: string }) {
  return (
    <div style={{
      width: 14,
      height: 14,
      borderRadius: "50%",
      background: color,
      border: "2px solid white",
      boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "white",
      fontSize: 7,
      fontWeight: 700,
    }} title={label}>
      ✈
    </div>
  );
}

// Marker dot component
function MarkerDot({ color, isAccommodation }: { color: string; isAccommodation: boolean }) {
  return (
    <div style={{
      width: isAccommodation ? 18 : 10,
      height: isAccommodation ? 18 : 10,
      borderRadius: "50%",
      background: isAccommodation ? "#fa8c16" : color,
      border: `1.5px solid white`,
      boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "white",
      fontSize: isAccommodation ? 10 : 0,
      fontWeight: 700,
    }}>
      {isAccommodation ? <HomeOutlined /> : ""}
    </div>
  );
}

// Route component — uses Routes API with per-session caching.
// Routes are cached by a hash of the coordinate path so each unique
// route is only computed once per page view.
export interface LegInfo { durationMinutes: number; distanceMiles: number }
export interface RouteInfo { durationMinutes: number; distanceMiles: number; legs: LegInfo[] }

// Module-level cache: pathKey → encoded polyline path or null (pending/failed)
const routeCache = new Map<string, google.maps.LatLng[] | "pending" | "failed">();
const routeInfoCache = new Map<string, RouteInfo>();

function pathKey(path: { lat: number; lng: number }[]): string {
  return path.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|");
}

/** Haversine distance in miles between two points */
function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3959; // Earth radius in miles
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * sinLng * sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Estimate route info from straight-line distances (1.3x detour factor, 45mph avg) */
function estimateRouteInfo(path: { lat: number; lng: number }[]): RouteInfo {
  const legs: LegInfo[] = [];
  let totalMiles = 0;
  for (let i = 1; i < path.length; i++) {
    const miles = Math.round(haversineMiles(path[i - 1], path[i]) * 1.3);
    const minutes = Math.round(miles / 45 * 60);
    legs.push({ durationMinutes: minutes, distanceMiles: miles });
    totalMiles += miles;
  }
  return {
    durationMinutes: Math.round(totalMiles / 45 * 60),
    distanceMiles: Math.round(totalMiles),
    legs,
  };
}

function DayRoute({ pathCoords, color, onRouteComputed }: {
  pathCoords: string; // stable string key from pathKey()
  color: string;
  onRouteComputed?: (info: RouteInfo) => void;
}) {
  const map = useMap(MAP_ID);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);
  const path = useMemo(() =>
    pathCoords.split("|").map((s) => {
      const [lat, lng] = s.split(",").map(Number);
      return { lat, lng };
    }),
    [pathCoords],
  );

  useEffect(() => {
    if (!map || path.length < 2) return;

    // Cleanup previous
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    const key = pathCoords;
    const cached = routeCache.get(key);

    if (cached === "pending") return; // another instance is computing this

    function failWithEstimate() {
      routeCache.set(key, "failed");
      drawFallback();
      // Provide estimated route info from straight-line distances
      if (!routeInfoCache.has(key)) {
        const est = estimateRouteInfo(path);
        routeInfoCache.set(key, est);
        onRouteComputed?.(est);
      }
    }

    if (cached === "failed" || !cached) {
      if (cached === "failed") {
        drawFallback();
        const info = routeInfoCache.get(key);
        if (info) onRouteComputed?.(info);
        return;
      }

      // Try the Routes API
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const routesNs = (google.maps as any).routes;
      if (!routesNs?.Route?.computeRoutes) {
        failWithEstimate();
        return;
      }

      routeCache.set(key, "pending");

      const origin = path[0];
      const destination = path[path.length - 1];
      const intermediates = path.slice(1, -1);

      routesNs.Route.computeRoutes({
        origin: new google.maps.LatLng(origin.lat, origin.lng),
        destination: new google.maps.LatLng(destination.lat, destination.lng),
        intermediates: intermediates.map((p) => new google.maps.LatLng(p.lat, p.lng)),
        travelMode: "DRIVING",
        fields: ["path", "durationMillis", "distanceMeters", "legs"],
      })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then(({ routes: computedRoutes }: { routes: any[] }) => {
          if (computedRoutes?.[0]) {
            const route = computedRoutes[0];
            // Cache the decoded path
            const routePolylines: google.maps.Polyline[] = route.createPolylines();
            const allPoints: google.maps.LatLng[] = [];
            routePolylines.forEach((pl: google.maps.Polyline) => {
              allPoints.push(...pl.getPath().getArray());
              pl.setMap(null); // clean up the auto-created polylines
            });
            routeCache.set(key, allPoints);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const legs: LegInfo[] = (route.legs || []).map((leg: any) => ({
              durationMinutes: Math.round((leg.durationMillis ?? 0) / 60000),
              distanceMiles: Math.round((leg.distanceMeters ?? 0) / 1609),
            }));
            const info: RouteInfo = {
              durationMinutes: Math.round((route.durationMillis ?? 0) / 60000),
              distanceMiles: Math.round((route.distanceMeters ?? 0) / 1609),
              legs,
            };
            routeInfoCache.set(key, info);

            // Draw from cache
            drawCached(allPoints);
            onRouteComputed?.(info);
          } else {
            failWithEstimate();
          }
        })
        .catch(() => {
          failWithEstimate();
        });
    } else {
      // Cache hit — draw the cached polyline
      drawCached(cached);
      const info = routeInfoCache.get(key);
      if (info) onRouteComputed?.(info);
    }

    function drawCached(points: google.maps.LatLng[]) {
      const polyline = new google.maps.Polyline({
        path: points,
        strokeColor: color,
        strokeOpacity: 0.7,
        strokeWeight: 4,
        map,
      });
      polylinesRef.current = [polyline];
    }

    function drawFallback() {
      const polyline = new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.4,
        strokeWeight: 2,
        map,
      });
      polylinesRef.current = [polyline];
    }

    return () => {
      polylinesRef.current.forEach((p) => p.setMap(null));
    };
  }, [map, pathCoords, color]); // pathCoords is a stable string, not a new array

  return null;
}

export interface DayRouteInfo { [dayIndex: number]: RouteInfo }

/** Renders inside <GoogleMap> to pan/zoom when the focused day changes */
function FitBoundsToDay({ visibleDays, selectedDay }: {
  visibleDays: Array<{
    activities: Activity[];
    flightSegments: Array<{ from: { lat: number; lng: number }; to: { lat: number; lng: number } }>;
  }>;
  selectedDay: number | "all";
}) {
  const map = useMap(MAP_ID);
  useEffect(() => {
    if (!map || visibleDays.length === 0) return;

    const points: Array<{ lat: number; lng: number }> = [];
    for (const d of visibleDays) {
      for (const a of d.activities) {
        if (a.lat != null && a.lng != null) points.push({ lat: a.lat, lng: a.lng });
      }
      for (const seg of d.flightSegments) {
        points.push(seg.from, seg.to);
      }
    }
    if (points.length === 0) return;

    if (points.length === 1) {
      map.panTo(points[0]);
      map.setZoom(14);
      return;
    }

    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, { top: 50, bottom: 50, left: 50, right: 50 });
  }, [map, visibleDays, selectedDay]);

  return null;
}

interface ItineraryMapProps {
  itinerary: Itinerary;
  activities: Activity[];
  activityMap: globalThis.Map<string, Activity>;
  focusDay?: number | null;
  onRouteInfo?: (info: DayRouteInfo) => void;
}

export function ItineraryMap({ itinerary, activities, activityMap, focusDay, onRouteInfo }: ItineraryMapProps) {
  const selectedDay: number | "all" = focusDay != null ? focusDay : "all";
  const [selectedActivity, setSelectedActivity] = useState<string | null>(null);

  // Use Google Maps API key from env
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apiKey = (import.meta as any).env?.VITE_GOOGLE_MAPS_API_KEY || "";

  // Build day-to-activity mapping with colors
  // For each day, find its lodging (Accommodation category) to bookend routes.
  // Flights are treated separately — they render as segments with two endpoints
  // (from/to airports) and aren't included in the driving route.
  const dayActivities = useMemo(() => {
    const days = itinerary.days.map((day, i) => {
      const allSlots = [...day.slots, ...(day.flights || [])];
      const slotActivitiesRaw = allSlots
        .map((s) => activityMap.get(s.activityId))
        .filter((a): a is Activity => a != null);

      // Separate flights from other activities. Skip flights where either end
      // is marked as "home" — those bookend legs stretch the map back to the
      // origin airport and obscure the actual trip.
      const flightSegments = slotActivitiesRaw
        .filter((a) =>
          a.category === "Flight" &&
          a.flightInfo?.fromLat != null && a.flightInfo?.fromLng != null &&
          a.flightInfo?.toLat != null && a.flightInfo?.toLng != null,
        )
        .filter((a) => !a.flightInfo!.fromIsHome && !a.flightInfo!.toIsHome)
        .map((a) => ({
          activity: a,
          from: { lat: a.flightInfo!.fromLat!, lng: a.flightInfo!.fromLng! },
          to: { lat: a.flightInfo!.toLat!, lng: a.flightInfo!.toLng! },
        }));

      const nonFlightActivities = slotActivitiesRaw
        .filter((a) => a.category !== "Flight" && a.lat != null && a.lng != null);

      const lodging = day.lodgingActivityId
        ? activityMap.get(day.lodgingActivityId)
        : nonFlightActivities.find((a) => a.category === "Accommodation"); // fallback for old data

      const nonLodging = nonFlightActivities.filter((a) => a.id !== lodging?.id);
      const lodgingHasCoords = lodging != null && lodging.lat != null && lodging.lng != null;
      const allDayActivities = [
        ...(lodgingHasCoords ? [lodging!] : []),
        ...nonLodging,
      ];

      return {
        day,
        dayIndex: i,
        color: DAY_COLORS[i % DAY_COLORS.length],
        activities: allDayActivities,
        flightSegments,
        lodging: lodgingHasCoords ? lodging : undefined,
        nonLodging,
      };
    });

    return days;
  }, [itinerary, activityMap]);


  // Scheduled activities with coords (for bounds/center)
  const scheduledWithCoords = useMemo(() => {
    const scheduledIds = new Set<string>();
    for (const da of dayActivities) {
      for (const a of da.activities) scheduledIds.add(a.id);
    }
    return activities.filter((a) => scheduledIds.has(a.id) && a.lat != null && a.lng != null);
  }, [activities, dayActivities]);

  // Compute center and zoom from scheduled activities only
  const defaultCenter = useMemo(() => {
    const source = scheduledWithCoords.length > 0 ? scheduledWithCoords : activities.filter((a) => a.lat != null);
    if (source.length === 0) return { lat: 39.8283, lng: -98.5795 };
    const lats = source.map((a) => a.lat!);
    const lngs = source.map((a) => a.lng!);
    return {
      lat: (Math.min(...lats) + Math.max(...lats)) / 2,
      lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    };
  }, [scheduledWithCoords, activities]);

  // Compute zoom from bounds spread
  const defaultZoom = useMemo(() => {
    const source = scheduledWithCoords.length > 0 ? scheduledWithCoords : activities.filter((a) => a.lat != null);
    if (source.length <= 1) return 12;
    const lats = source.map((a) => a.lat!);
    const lngs = source.map((a) => a.lng!);
    const latSpread = Math.max(...lats) - Math.min(...lats);
    const lngSpread = Math.max(...lngs) - Math.min(...lngs);
    const maxSpread = Math.max(latSpread, lngSpread);
    if (maxSpread > 5) return 6;
    if (maxSpread > 2) return 7;
    if (maxSpread > 1) return 8;
    if (maxSpread > 0.5) return 9;
    if (maxSpread > 0.2) return 10;
    if (maxSpread > 0.05) return 12;
    return 13;
  }, [scheduledWithCoords, activities]);

  // Visible days based on filter
  const visibleDays = useMemo(() => {
    if (selectedDay === "all") return dayActivities;
    return dayActivities.filter((d) => d.dayIndex === selectedDay);
  }, [dayActivities, selectedDay]);

  const handleMarkerClick = useCallback((actId: string) => {
    setSelectedActivity(actId === selectedActivity ? null : actId);
  }, [selectedActivity]);

  if (!apiKey) {
    return <Typography.Text type="secondary">Maps API key not configured</Typography.Text>;
  }

  const anyWithCoords = activities.some((a) => a.lat != null && a.lng != null);
  if (!anyWithCoords) {
    return (
      <Typography.Text type="secondary">
        No activities have coordinates yet. Add lat/lng to activities to see them on the map.
      </Typography.Text>
    );
  }

  return (
    <Container>
      <MapWrapper>
        <APIProvider apiKey={apiKey} libraries={["routes"]}>
          <GoogleMap
            id={MAP_ID}
            defaultCenter={defaultCenter}
            defaultZoom={defaultZoom}
            gestureHandling="greedy"
            disableDefaultUI={false}
            mapId={MAP_ID}
            style={{ width: "100%", height: "100%" }}
          >
            <FitBoundsToDay visibleDays={visibleDays} selectedDay={selectedDay} />
            {/* Day routes — start from previous day's lodging, end at this day's lodging */}
            {visibleDays.map((da) => {
              // This day's lodging (where you sleep tonight)
              const todayLodging = da.lodging
                || dayActivities.slice(da.dayIndex + 1).find((d) => d.lodging)?.lodging;

              // Previous day's lodging (where you woke up) — or arrival airport for day 1
              const prevLodging = dayActivities.slice(0, da.dayIndex).reverse().find((d) => d.lodging)?.lodging;
              const startLodging = prevLodging || todayLodging;

              const startCoord = startLodging && startLodging.lat != null
                ? { lat: startLodging.lat!, lng: startLodging.lng! }
                : null;

              const endCoord = todayLodging && todayLodging.lat != null
                ? { lat: todayLodging.lat!, lng: todayLodging.lng! }
                : startCoord; // fallback to same if no lodging change

              const activityCoords = da.nonLodging
                .filter((a) => a.lat != null && a.lng != null)
                .map((a) => ({ lat: a.lat!, lng: a.lng! }));

              // Build path: start lodging → activities → end lodging
              const path = [
                ...(startCoord ? [startCoord] : []),
                ...activityCoords,
                ...(endCoord && (endCoord.lat !== startCoord?.lat || endCoord.lng !== startCoord?.lng) ? [endCoord] : []),
                // If same lodging, still add it to complete the loop
                ...(endCoord && startCoord && endCoord.lat === startCoord.lat && endCoord.lng === startCoord.lng ? [endCoord] : []),
              ];

              const coords = pathKey(path);
              return <DayRoute key={da.dayIndex} pathCoords={coords} color={da.color}
                onRouteComputed={(info) => onRouteInfo?.({ [da.dayIndex]: info })} />;
            })}

            {/* Scheduled activity markers */}
            {visibleDays.flatMap((da) =>
              da.activities.map((activity) => {
                const isAccommodation = activity.category === "Accommodation";
                return (
                  <AdvancedMarker
                    key={activity.id}
                    position={{ lat: activity.lat!, lng: activity.lng! }}
                    onClick={() => handleMarkerClick(activity.id)}
                  >
                    <MarkerDot color={da.color} isAccommodation={isAccommodation} />
                  </AdvancedMarker>
                );
              })
            )}

            {/* Flight segments: dashed line + markers at both endpoints */}
            {visibleDays.flatMap((da) =>
              da.flightSegments.flatMap((seg) => {
                const fi = seg.activity.flightInfo;
                const label = [fi?.airline && fi?.number ? `${fi.airline}${fi.number}` : "", fi?.from, fi?.to]
                  .filter(Boolean).join(" ");
                return [
                  <FlightSegment
                    key={`seg-${seg.activity.id}`}
                    from={seg.from}
                    to={seg.to}
                    color={da.color}
                  />,
                  <AdvancedMarker
                    key={`from-${seg.activity.id}`}
                    position={seg.from}
                    onClick={() => handleMarkerClick(seg.activity.id)}
                  >
                    <FlightMarker color={da.color} label={`${label} departure`} />
                  </AdvancedMarker>,
                  <AdvancedMarker
                    key={`to-${seg.activity.id}`}
                    position={seg.to}
                    onClick={() => handleMarkerClick(seg.activity.id)}
                  >
                    <FlightMarker color={da.color} label={`${label} arrival`} />
                  </AdvancedMarker>,
                ];
              })
            )}


            {/* Info window */}
            {selectedActivity && (() => {
              const activity = activityMap.get(selectedActivity);
              if (!activity || activity.lat == null || activity.lng == null) return null;
              return (
                <InfoWindow
                  position={{ lat: activity.lat!, lng: activity.lng! }}
                  onCloseClick={() => setSelectedActivity(null)}
                >
                  <InfoContent>
                    {activity.photoRef && (
                      <img
                        src={`https://places.googleapis.com/v1/${activity.photoRef}/media?maxWidthPx=300&key=${apiKey}`}
                        alt={activity.name}
                        style={{ width: "100%", height: 120, objectFit: "cover", borderRadius: 4, marginBottom: 6 }}
                      />
                    )}
                    <InfoTitle>
                      {activity.placeId ? (
                        <a
                          href={`https://www.google.com/maps/place/?q=place_id:${activity.placeId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "inherit" }}
                        >
                          {activity.name} ↗
                        </a>
                      ) : (
                        activity.name
                      )}
                    </InfoTitle>
                    <InfoMeta>
                      {activity.rating != null && (
                        <InfoRow>
                          <span style={{ color: "#fa8c16" }}>★ {activity.rating}</span>
                          {activity.ratingCount != null && (
                            <span style={{ color: "#8c8c8c" }}>({activity.ratingCount.toLocaleString()})</span>
                          )}
                        </InfoRow>
                      )}
                      {activity.location && <InfoRow><EnvironmentOutlined /> {activity.location}</InfoRow>}
                      <InfoRow>
                        <Tag style={{ margin: 0, fontSize: 11, lineHeight: "16px", padding: "0 4px" }}>
                          {activity.category}
                        </Tag>
                      </InfoRow>
                      {activity.durationEstimate && <InfoRow><ClockCircleOutlined /> {activity.durationEstimate}</InfoRow>}
                      {activity.costNotes && <InfoRow><DollarOutlined /> {activity.costNotes}</InfoRow>}
                      {activity.description && (
                        <div style={{ marginTop: 4, color: "#8c8c8c" }}>{activity.description}</div>
                      )}
                    </InfoMeta>
                  </InfoContent>
                </InfoWindow>
              );
            })()}
          </GoogleMap>
        </APIProvider>
      </MapWrapper>

    </Container>
  );
}
