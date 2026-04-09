import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Declare context variables set by auth middleware
export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
    userToken: string;
  };
};
import { authMiddleware } from "./middleware/auth";
import { recipesRoutes } from "./routes/recipes";
import { aiRoutes } from "./routes/ai";
import { sharingRoutes } from "./routes/sharing";
import { dataRoutes } from "./routes/data";
import { pushRoutes } from "./routes/push";
const app = new Hono<AppEnv>();

// CORS — allow all beta.kirkl.in origins
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    if (origin.endsWith(".kirkl.in") || origin.endsWith(".localhost") || origin.includes("localhost:")) {
      return origin;
    }
    return undefined;
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// Health check (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));

// All other routes require auth
app.use("*", authMiddleware);

// Mount route groups
app.route("/recipes", recipesRoutes);
app.route("/ai", aiRoutes);
app.route("/sharing", sharingRoutes);
app.route("/data", dataRoutes);
app.route("/push", pushRoutes);

const port = parseInt(process.env.PORT || "3000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API server running on port ${info.port}`);
});
