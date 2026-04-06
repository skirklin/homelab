import { initializeApp, getApps, type FirebaseApp } from "firebase/app";
import { getAuth, connectAuthEmulator, type Auth } from "firebase/auth";
import {
  initializeFirestore,
  connectFirestoreEmulator,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
};

let app: FirebaseApp;
let auth: Auth;
let db: Firestore;
let initialized = false;

export function initializeBackend(authDomain: string) {
  if (initialized) {
    return { app, auth, db };
  }

  // Check if already initialized (e.g., in HMR scenarios)
  const existingApps = getApps();
  if (existingApps.length > 0) {
    app = existingApps[0];
  } else {
    app = initializeApp({ ...firebaseConfig, authDomain });
  }

  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });

  // Connect to emulators in development (skip if VITE_USE_PROD is set)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const useProd = typeof import.meta !== "undefined" && (import.meta as any).env?.VITE_USE_PROD;
  if (typeof window !== "undefined" && window.location.hostname === "localhost" && !useProd) {
    try {
      connectAuthEmulator(auth, "http://localhost:9099", { disableWarnings: true });
      connectFirestoreEmulator(db, "localhost", 8180);
    } catch {
      // Already connected
    }
  }

  initialized = true;
  return { app, auth, db };
}

export function getBackend() {
  if (!initialized) {
    throw new Error("Backend not initialized. Call initializeBackend() first.");
  }
  return { app, auth, db };
}

export { app, auth, db };
