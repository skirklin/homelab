// Re-export from shared backend
import { initializeBackend, getBackend } from "@kirkl/shared";

// Initialize on import (for standalone mode)
initializeBackend("groceries.kirkl.in");

export const { app, auth, db } = getBackend();
