import { initializeBackend, getBackend } from "@kirkl/shared";

// Initialize shared backend with upkeep auth domain
initializeBackend("upkeep.kirkl.in");

const { app, db, auth } = getBackend();
export { app, db, auth };
