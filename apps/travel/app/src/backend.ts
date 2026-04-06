import { initializeBackend, getBackend } from "@kirkl/shared";

// Initialize shared backend with travel auth domain
initializeBackend("travel.kirkl.in");

const { app, db, auth } = getBackend();
export { app, db, auth };
