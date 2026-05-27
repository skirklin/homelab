/**
 * /quick/:trackableId?v=<canonicalValue>
 *
 * Deep-link target for the PWA web-manifest `shortcuts[]` (Android long-press
 * on the app icon, desktop right-click jumplist). Logs exactly one event in
 * the trackable's canonical storage unit — no category, intensity, or notes
 * — and bounces back to the dashboard. Same fast-path shape as the preset
 * chips on the EventLogger card.
 *
 * Failure modes are kept user-friendly: an unknown trackable, missing/invalid
 * `?v=`, or a backend error all surface a toast and redirect to "/" so the
 * user is never stranded on a blank screen launched from a home-screen
 * shortcut.
 */
import { useEffect, useRef } from "react";
import { Navigate, useParams, useSearchParams } from "react-router-dom";
import { Spin } from "antd";
import styled from "styled-components";
import { useAuth, useFeedback, useLifeBackend } from "@kirkl/shared";
import type { LifeEntry } from "@homelab/backend";
import { useLifeContext } from "../life-context";
import { getTrackable } from "../manifest";
import { primaryEntryName, formatDuration, formatDose, formatRating } from "../lib/format";

const Splash = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 50vh;
`;

export function QuickLog() {
  const { trackableId } = useParams<{ trackableId: string }>();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const { state } = useLifeContext();
  const life = useLifeBackend();
  const { message } = useFeedback();
  // Strict Mode double-mount + the user pressing back-then-forward could
  // re-run the effect. Guard so we don't write duplicate events.
  const submittedRef = useRef(false);

  const trackable = trackableId ? getTrackable(trackableId) : undefined;
  const rawValue = searchParams.get("v");
  const parsedValue = rawValue !== null ? Number(rawValue) : NaN;
  const valueValid = Number.isFinite(parsedValue);

  useEffect(() => {
    if (submittedRef.current) return;
    if (!trackable) {
      message.error(`Unknown trackable: ${trackableId ?? "(missing)"}`);
      submittedRef.current = true;
      return;
    }
    if (!valueValid) {
      message.error(`Quick-log needs a ?v= value`);
      submittedRef.current = true;
      return;
    }
    // Wait for auth + log to load. The parent LifeRoutesInner already gates
    // on `state.log`, so by the time we mount we should have both — but it's
    // cheap insurance.
    if (!user?.uid || !state.log?.id) return;

    submittedRef.current = true;
    const primary = primaryEntryName(trackable.id);
    const entries: LifeEntry[] =
      trackable.unit === "rating"
        ? [{ name: primary, type: "number", value: parsedValue, unit: "rating", scale: 5 }]
        : [{ name: primary, type: "number", value: parsedValue, unit: trackable.unit }];

    life
      .addEvent(state.log.id, trackable.id, entries, user.uid)
      .then(() => {
        message.success(`Logged ${formatPreview(parsedValue, trackable.unit)} ${trackable.label.toLowerCase()}`);
      })
      .catch((err) => {
        console.error("QuickLog failed:", err);
        message.error("Failed to log");
      });
  }, [trackable, trackableId, valueValid, parsedValue, user?.uid, state.log?.id, life, message]);

  // Redirect once we've fired (or decided not to). The submittedRef flips
  // synchronously above so this re-render reaches the Navigate immediately.
  if (submittedRef.current) {
    return <Navigate to="/" replace />;
  }

  return (
    <Splash>
      <Spin size="large" />
    </Splash>
  );
}

function formatPreview(value: number, unit: string): string {
  if (unit === "min") return formatDuration(value);
  if (unit === "rating") return formatRating(value);
  return formatDose(value, unit);
}
