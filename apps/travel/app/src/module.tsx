import { Routes, Route } from "react-router-dom";
import { useAuth } from "@kirkl/shared";
import { BackendProvider } from "@kirkl/shared";
import { TravelProvider } from "./travel-context";
import { TripList } from "./components/TripList";
import { TripDetail } from "./components/TripDetail";
import { TripForm } from "./components/TripForm";
import { ActivityForm } from "./components/ActivityForm";
import { LogLoader } from "./components/LogLoader";
import { InviteRedeem } from "./components/InviteRedeem";

interface TravelRoutesProps {
  embedded?: boolean;
}

export function TravelRoutes({ embedded = false }: TravelRoutesProps) {
  const { user } = useAuth();

  if (!user) return null;

  return (
    <Routes>
      <Route path="invite/:code" element={<InviteRedeem />} />
      <Route element={<LogLoader />}>
        <Route index element={<TripList embedded={embedded} />} />
        <Route path="new" element={<TripForm />} />
        <Route path=":tripId" element={<TripDetail />} />
        <Route path=":tripId/edit" element={<TripForm />} />
        <Route path=":tripId/activities/new" element={<ActivityForm />} />
        <Route path=":tripId/activities/:activityId/edit" element={<ActivityForm />} />
      </Route>
    </Routes>
  );
}

export function TravelModule() {
  return (
    <BackendProvider>
      <TravelProvider>
        <TravelRoutes />
      </TravelProvider>
    </BackendProvider>
  );
}

export { TravelProvider, useTravelContext } from "./travel-context";
