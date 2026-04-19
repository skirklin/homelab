import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

// Declare context variables set by auth middleware
export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
    userToken: string;
    isApiKey: boolean;
    pb: import("pocketbase").default;
  };
};
import { authMiddleware } from "./middleware/auth";
import { recipesRoutes } from "./routes/recipes";
import { aiRoutes } from "./routes/ai";
import { sharingRoutes } from "./routes/sharing";
import { dataRoutes } from "./routes/data";
import { pushRoutes } from "./routes/push";
import { authRoutes } from "./routes/auth";
import { notificationRoutes } from "./routes/notifications";
import { startScheduler } from "./lib/notifications/scheduler";
const app = new Hono<AppEnv>();

// CORS — allow kirkl.in and any subdomain (incl. beta.kirkl.in), plus local dev
app.use("*", cors({
  origin: (origin) => {
    if (!origin) return origin;
    const host = origin.replace(/^https?:\/\//, "").split(":")[0];
    if (host === "kirkl.in" || host.endsWith(".kirkl.in") || host === "localhost" || host.endsWith(".localhost")) {
      return origin;
    }
    return undefined;
  },
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
}));

// Public endpoints (no auth)
app.get("/health", (c) => c.json({ status: "ok" }));
app.get("/push/vapid-key", (c) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return c.json({ error: "VAPID keys not configured" }, 503);
  return c.json({ publicKey: key });
});
// List info for join flow — needs to work before user is an owner
app.get("/sharing/list-info/:collection/:listId", async (c) => {
  const { getAdminPb } = await import("./lib/pb");
  const collection = c.req.param("collection") ?? "";
  const listId = c.req.param("listId") ?? "";
  const allowed = ["shopping_lists", "task_lists", "life_logs"];
  if (!allowed.includes(collection)) return c.json({ error: "Invalid collection" }, 400);
  try {
    const pb = await getAdminPb();
    const record = await pb.collection(collection).getOne(listId, { $autoCancel: false });
    return c.json({ id: record.id, name: record.name });
  } catch {
    return c.json({ error: "List not found" }, 404);
  }
});

// All other routes require auth
app.use("*", authMiddleware);

// Mount route groups
app.route("/recipes", recipesRoutes);
app.route("/ai", aiRoutes);
app.route("/sharing", sharingRoutes);
app.route("/data", dataRoutes);
app.route("/push", pushRoutes);
app.route("/auth", authRoutes);
app.route("/notifications", notificationRoutes);

const port = parseInt(process.env.PORT || "3000");

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API server running on port ${info.port}`);
  startScheduler();
});
