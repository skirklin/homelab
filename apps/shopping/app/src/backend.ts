import { initializeBackend } from "@kirkl/shared";

// Initialize PocketBase on import
const pb = initializeBackend();

export { pb };
export { getBackend } from "@kirkl/shared";
