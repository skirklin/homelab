import { useMemo } from "react";
import { Typography, Progress } from "antd";
import {
  CheckCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import type { Trip, Activity, Itinerary } from "../types";

const Container = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const StatusRow = styled.div<{ $color: string }>`
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: ${(p) => p.$color}08;
  border-left: 3px solid ${(p) => p.$color};
  font-size: 12px;
`;

const StatusIcon = styled.span<{ $color: string }>`
  color: ${(p) => p.$color};
  font-size: 13px;
  flex-shrink: 0;
  padding-top: 1px;
`;

const StatusContent = styled.div`
  flex: 1;
`;

const StatusTitle = styled.div`
  font-weight: 500;
  font-size: 12px;
`;

const StatusDetail = styled.div`
  color: #8c8c8c;
  font-size: 11px;
  margin-top: 1px;
`;

const SectionLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: #8c8c8c;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-top: 4px;
`;

interface ReadinessDashboardProps {
  trip: Trip;
  activities: Activity[];
  itineraries: Itinerary[];
}

interface ReadinessItem {
  status: "done" | "warning" | "needed";
  category: string;
  title: string;
  detail?: string;
}

export function ReadinessDashboard({ trip, activities, itineraries }: ReadinessDashboardProps) {
  const items = useMemo(() => {
    const result: ReadinessItem[] = [];
    const now = new Date();
    const daysUntil = trip.startDate
      ? Math.ceil((trip.startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
      : null;

    const activeItin = itineraries.find((i) => i.isActive) || itineraries[0];

    // Flights
    const flights = activities.filter((a) => a.category === "Flight");
    if (flights.length > 0) {
      const confirmed = flights.filter((f) => f.confirmationCode);
      const unconfirmed = flights.filter((f) => !f.confirmationCode);
      if (confirmed.length > 0) {
        result.push({
          status: "done",
          category: "Flights",
          title: `${confirmed.length} flight(s) booked`,
          detail: confirmed.map((f) => `${f.name} — ${f.confirmationCode}`).join(", "),
        });
      }
      for (const f of unconfirmed) {
        result.push({
          status: "needed",
          category: "Flights",
          title: `Book: ${f.name}`,
          detail: f.costNotes || undefined,
        });
      }
    } else if (trip.status === "Booked" || trip.status === "Researching") {
      result.push({
        status: "needed",
        category: "Flights",
        title: "No flights added yet",
      });
    }

    // Lodging
    if (activeItin) {
      const daysWithLodging = activeItin.days.filter((d) => d.lodgingActivityId);
      // A day counts as a "departure day" (no lodging needed) when either:
      //   1. Any flight activity on the day has flightInfo.toIsHome === true
      //      (explicit signal — preferred when present), OR
      //   2. It's the last day of the itinerary AND the day contains at least
      //      one Flight-category activity (in slots or flights). Last day +
      //      flight is overwhelmingly a fly-home day; intermediate days with
      //      internal flights aren't suppressed.
      const isDepartureDay = (
        day: typeof activeItin.days[number],
        dayIndex: number,
        days: typeof activeItin.days,
      ): boolean => {
        const allSlots = [...(day.flights || []), ...day.slots];
        const slotActivities = allSlots
          .map((s) => activities.find((a) => a.id === s.activityId))
          .filter((a): a is Activity => a != null);
        if (slotActivities.some((a) => a.flightInfo?.toIsHome === true)) {
          return true;
        }
        if (dayIndex === days.length - 1) {
          return slotActivities.some((a) => a.category === "Flight");
        }
        return false;
      };
      const daysWithout = activeItin.days.filter(
        (d, i, days) => !d.lodgingActivityId && d.slots.length > 0 && !isDepartureDay(d, i, days),
      );
      if (daysWithLodging.length > 0) {
        const lodgingNames = [...new Set(
          daysWithLodging
            .map((d) => activities.find((a) => a.id === d.lodgingActivityId)?.name)
            .filter(Boolean)
        )];
        result.push({
          status: "done",
          category: "Lodging",
          title: `${daysWithLodging.length} night(s) covered`,
          detail: lodgingNames.join(", "),
        });
      }
      if (daysWithout.length > 0) {
        result.push({
          status: "needed",
          category: "Lodging",
          title: `${daysWithout.length} night(s) need lodging`,
          detail: daysWithout.map((d) => d.label).join(", "),
        });
      }
    }

    // Rental car
    const rentalCar = activities.find((a) =>
      a.category === "Transportation" && (a.name.toLowerCase().includes("rental") || a.name.toLowerCase().includes("enterprise") || a.name.toLowerCase().includes("hertz"))
    );
    if (rentalCar) {
      result.push({
        status: rentalCar.confirmationCode ? "done" : "warning",
        category: "Transport",
        title: rentalCar.name,
        detail: rentalCar.confirmationCode ? `Confirmation: ${rentalCar.confirmationCode}` : "No confirmation code",
      });
    }

    // Booking/prep tasks are tracked as outliner tasks tagged `travel:<tripId>`
    // (see TripChecklist). They surface in the Prep tab rather than here so the
    // readiness dashboard doesn't double-count them.

    // Itinerary completeness
    if (activeItin) {
      const emptyDays = activeItin.days.filter((d) => d.slots.length === 0 && (!d.flights || d.flights.length === 0));
      if (emptyDays.length > 0) {
        result.push({
          status: "warning",
          category: "Itinerary",
          title: `${emptyDays.length} day(s) have no activities`,
          detail: emptyDays.map((d) => d.label).join(", "),
        });
      }
    } else {
      result.push({
        status: "needed",
        category: "Itinerary",
        title: "No itinerary created yet",
      });
    }

    // Activities without coords (won't render as a marker on the itinerary map).
    // Use lat/lng — that's what ItineraryMap actually gates on. placeId can be
    // set by a search even when geocoding hasn't filled in coords.
    const ungeocodedInItin = activeItin ? activeItin.days.flatMap((d) =>
      d.slots.map((s) => activities.find((a) => a.id === s.activityId))
        .filter((a): a is Activity => a != null && (a.lat == null || a.lng == null))
    ) : [];
    if (ungeocodedInItin.length > 0) {
      result.push({
        status: "warning",
        category: "Map",
        title: `${ungeocodedInItin.length} scheduled activity(ies) not on map`,
        detail: ungeocodedInItin.map((a) => a.name).slice(0, 3).join(", ") + (ungeocodedInItin.length > 3 ? "..." : ""),
      });
    }

    // General time-based reminders
    if (daysUntil != null && daysUntil > 0) {
      if (daysUntil <= 1) {
        result.push({ status: "warning", category: "Prep", title: "Trip is tomorrow!", detail: "Check in for flights, charge devices, download offline maps" });
      } else if (daysUntil <= 3) {
        result.push({ status: "warning", category: "Prep", title: `${daysUntil} days away`, detail: "Check weather, confirm reservations, pack" });
      } else if (daysUntil <= 7) {
        result.push({ status: "warning", category: "Prep", title: `${daysUntil} days away`, detail: "Check weather, start packing, notify bank" });
      }
    }

    return result;
  }, [trip, activities, itineraries]);

  const doneCount = items.filter((i) => i.status === "done").length;
  const totalCount = items.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const statusColor = (s: ReadinessItem["status"]) => {
    switch (s) {
      case "done": return "#52c41a";
      case "warning": return "#fa8c16";
      case "needed": return "#ff4d4f";
    }
  };

  const statusIcon = (s: ReadinessItem["status"]) => {
    switch (s) {
      case "done": return <CheckCircleOutlined />;
      case "warning": return <WarningOutlined />;
      case "needed": return <ClockCircleOutlined />;
    }
  };

  if (items.length === 0) return null;

  // Group by category
  const categories = [...new Set(items.map((i) => i.category))];

  return (
    <Container>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Progress
          type="circle"
          percent={pct}
          size={40}
          strokeColor={pct === 100 ? "#52c41a" : pct >= 60 ? "#fa8c16" : "#ff4d4f"}
          format={() => `${doneCount}/${totalCount}`}
        />
        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>Trip Readiness</Typography.Text>
          <div style={{ fontSize: 11, color: "#8c8c8c" }}>
            {doneCount === totalCount ? "All set!" : `${totalCount - doneCount} item(s) need attention`}
          </div>
        </div>
      </div>

      {categories.map((cat) => (
        <div key={cat}>
          <SectionLabel>{cat}</SectionLabel>
          {items.filter((i) => i.category === cat).map((item, j) => (
            <StatusRow key={j} $color={statusColor(item.status)}>
              <StatusIcon $color={statusColor(item.status)}>
                {statusIcon(item.status)}
              </StatusIcon>
              <StatusContent>
                <StatusTitle>{item.title}</StatusTitle>
                {item.detail && <StatusDetail>{item.detail}</StatusDetail>}
              </StatusContent>
            </StatusRow>
          ))}
        </div>
      ))}
    </Container>
  );
}
