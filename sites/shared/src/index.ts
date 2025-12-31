// Backend
export { initializeBackend, getBackend, app, auth, db } from "./backend";

// Auth
export { AuthProvider, useAuth, AuthContext } from "./auth";

// Test utilities (for e2e tests with emulators)
export * from "./test-utils";
