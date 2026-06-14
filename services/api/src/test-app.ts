/**
 * Exports the Hono app for testing without starting the HTTP server.
 * Import this from tests instead of index.ts.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";

export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
    userToken: string;
    isApiKey: boolean;
    tokenRoles: string[];
    pb: import("pocketbase").default;
  };
};

import { authMiddleware } from "./middleware/auth";
import { healthIngestHandler } from "./routes/health-ingest";
import { screentimeIngestHandler } from "./routes/screentime-ingest";
import { recipesRoutes } from "./routes/recipes";
import { aiRoutes } from "./routes/ai";
import { sharingRoutes } from "./routes/sharing";
import { dataRoutes } from "./routes/data";
import { travelRoutes } from "./routes/travel";
import { pushRoutes } from "./routes/push";
import { authRoutes } from "./routes/auth";

export const app = new Hono<AppEnv>();

app.use("*", cors({ origin: "*" }));

// Public
app.get("/health", (c) => c.json({ status: "ok" }));

// Auth required
app.use("*", authMiddleware);

app.post("/health/ingest", healthIngestHandler);
app.post("/screentime/ingest", screentimeIngestHandler);
app.route("/recipes", recipesRoutes);
app.route("/ai", aiRoutes);
app.route("/sharing", sharingRoutes);
app.route("/data", dataRoutes);
app.route("/travel", travelRoutes);
app.route("/push", pushRoutes);
app.route("/auth", authRoutes);

export default { app };
