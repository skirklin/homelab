/**
 * Firebase Admin SDK initialization.
 * Shared across all cloud function modules.
 */

import { initializeApp, getApps, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize app only if not already initialized
const app = getApps().length === 0 ? initializeApp() : getApp();

export const db = getFirestore(app);
export { app };
