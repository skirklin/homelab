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

// Route component — uses Routes API for driving routes, falls back to straight lines
export interface RouteInfo { durationMinutes: number; distanceMiles: number }

function DayRoute({ path, color, onRouteComputed }: {
  path: { lat: number; lng: number }[];
  color: string;
  onRouteComputed?: (info: RouteInfo) => void;
}) {
  const map = useMap(MAP_ID);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);

  useEffect(() => {
    if (!map || path.length < 2) return;

    // Cleanup previous
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    const origin = path[0];
    const destination = path[path.length - 1];
    const intermediates = path.slice(1, -1);

    // Use the new Routes API (google.maps.routes.Route.computeRoutes)
    // Types not yet in @types/google.maps, so use dynamic access
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const routesNs = (google.maps as any).routes;
    if (!routesNs?.Route?.computeRoutes) {
      drawFallback();
      return;
    }

    const request = {
      origin: new google.maps.LatLng(origin.lat, origin.lng),
      destination: new google.maps.LatLng(destination.lat, destination.lng),
      intermediates: intermediates.map((p) => new google.maps.LatLng(p.lat, p.lng)),
      travelMode: "DRIVING",
      fields: ["path", "durationMillis", "distanceMeters"],
    };

    routesNs.Route.computeRoutes(request)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then(({ routes: computedRoutes }: { routes: any[] }) => {
        if (computedRoutes && computedRoutes.length > 0) {
          const route = computedRoutes[0];
          const routePolylines: google.maps.Polyline[] = route.createPolylines();
          routePolylines.forEach((polyline: google.maps.Polyline) => {
            polyline.setOptions({
              strokeColor: color,
              strokeOpacity: 0.7,
              strokeWeight: 4,
            });
            polyline.setMap(map);
          });
          polylinesRef.current = routePolylines;

          if (onRouteComputed) {
            const durationMs = route.durationMillis ?? 0;
            const meters = route.distanceMeters ?? 0;
            onRouteComputed({
              durationMinutes: Math.round(durationMs / 60000),
              distanceMiles: Math.round(meters / 1609),
            });
          }
        } else {
          drawFallback();
        }
      })
      .catch(() => {
        drawFallback();
      });

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
  }, [map, path, color]);

  return null;
}

export interface DayRouteInfo { [dayIndex: number]: RouteInfo }

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
  // For each day, find its lodging (Accommodation category) to bookend routes
  const dayActivities = useMemo(() => {
    const days = itinerary.days.map((day, i) => {
      const slotActivities = day.slots
        .map((s) => activityMap.get(s.activityId))
        .filter((a): a is Activity => a != null && a.lat != null && a.lng != null);

      const flightActivities = (day.flights || [])
        .map((s) => activityMap.get(s.activityId))
        .filter((a): a is Activity => a != null && a.lat != null && a.lng != null);

      const lodging = day.lodgingActivityId
        ? activityMap.get(day.lodgingActivityId)
        : slotActivities.find((a) => a.category === "Accommodation"); // fallback for old data

      const nonLodging = slotActivities.filter((a) => a.id !== lodging?.id);
      const allDayActivities = [
        ...(lodging && lodging.lat != null ? [lodging] : []),
        ...nonLodging,
        ...flightActivities,
      ];

      return {
        day,
        dayIndex: i,
        color: DAY_COLORS[i % DAY_COLORS.length],
        activities: allDayActivities,
        lodging: lodging?.lat != null ? lodging : undefined,
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

              return <DayRoute key={da.dayIndex} path={path} color={da.color}
                onRouteComputed={onRouteInfo ? (info) => onRouteInfo({ [da.dayIndex]: info }) : undefined} />;
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


            {/* Info window */}
            {selectedActivity && (() => {
              const activity = activityMap.get(selectedActivity);
              if (!activity || activity.lat == null) return null;
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
