import { useMemo } from "react";
import { Typography, Progress } from "antd";
import {
  CheckCircleOutlined,
  WarningOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import styled from "styled-components";
import type { Trip, Activity, Itinerary, BookingRequirement } from "../types";

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
    const activeItin = itineraries.find((i) => i.isActive) || itineraries[0];
    if (activeItin) {
      const daysWithLodging = activeItin.days.filter((d) => d.lodgingActivityId);
      const daysWithout = activeItin.days.filter((d) => !d.lodgingActivityId && d.slots.length > 0);
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

    // Activities needing booking
    const needsBooking = activities.filter((a) =>
      a.description.toLowerCase().includes("book") ||
      a.description.toLowerCase().includes("reserve") ||
      a.description.toLowerCase().includes("waitlist")
    );
    for (const a of needsBooking) {
      result.push({
        status: a.confirmationCode ? "done" : "warning",
        category: "Bookings",
        title: a.name,
        detail: a.confirmationCode ? `Confirmed: ${a.confirmationCode}` : a.description,
      });
    }

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

    // Activities without geocoding (won't show on map)
    const ungeocodedInItin = activeItin ? activeItin.days.flatMap((d) =>
      d.slots.map((s) => activities.find((a) => a.id === s.activityId))
        .filter((a): a is Activity => a != null && !a.placeId)
    ) : [];
    if (ungeocodedInItin.length > 0) {
      result.push({
        status: "warning",
        category: "Map",
        title: `${ungeocodedInItin.length} scheduled activity(ies) not on map`,
        detail: ungeocodedInItin.map((a) => a.name).slice(0, 3).join(", ") + (ungeocodedInItin.length > 3 ? "..." : ""),
      });
    }

    // Aggregate booking requirements from all activities
    if (daysUntil != null && daysUntil > 0) {
      const allReqs: { activity: Activity; req: BookingRequirement }[] = [];
      for (const a of activities) {
        for (const req of a.bookingReqs || []) {
          allReqs.push({ activity: a, req });
        }
      }

      // Sort by deadline (most urgent first)
      allReqs.sort((a, b) => b.req.daysBefore - a.req.daysBefore);

      // Show overdue and upcoming booking tasks
      for (const { activity, req } of allReqs) {
        const deadline = req.daysBefore;
        const isOverdue = daysUntil <= deadline;
        const isDone = req.done;

        if (isDone) {
          result.push({
            status: "done",
            category: "Booking Tasks",
            title: `${activity.name}: ${req.action}`,
            detail: `Due ${deadline} days before trip`,
          });
        } else if (isOverdue) {
          result.push({
            status: "needed",
            category: "Booking Tasks",
            title: `${activity.name}: ${req.action}`,
            detail: `Was due ${deadline} days before trip — ${daysUntil} days left!`,
          });
        } else if (daysUntil <= deadline + 7) {
          // Coming up within a week of its deadline
          result.push({
            status: "warning",
            category: "Booking Tasks",
            title: `${activity.name}: ${req.action}`,
            detail: `Due ${deadline} days before trip (${deadline - daysUntil} days from now)`,
          });
        }
      }

      // General time-based reminders
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
