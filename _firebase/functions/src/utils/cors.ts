/**
 * CORS configuration for cloud functions.
 */

// Production domains only - localhost should be removed for production
export const ALLOWED_ORIGINS = [
  "https://recipes.kirkl.in",
  "https://home.kirkl.in",
  "https://kirkl.in",
  // Development only - consider using environment variables
  // "http://localhost:5000",
  // "http://localhost:5173",
];

/**
 * Standard CORS options for onCall functions.
 */
export const corsOptions = {
  cors: ALLOWED_ORIGINS,
  invoker: "public" as const,
};
