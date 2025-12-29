import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, enableIndexedDbPersistence } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  authDomain: "groceries.kirkl.in",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
};

export const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
if (import.meta.env.DEV) {
  connectAuthEmulator(auth, "http://localhost:9199");
}

export const db = getFirestore(app);
if (import.meta.env.DEV) {
  connectFirestoreEmulator(db, "localhost", 8180);
}

// Enable offline persistence
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Offline persistence unavailable: multiple tabs open");
  } else if (err.code === "unimplemented") {
    console.warn("Offline persistence unavailable: browser not supported");
  }
});
