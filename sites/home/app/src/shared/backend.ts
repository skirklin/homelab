import { initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator } from "firebase/auth";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  connectFirestoreEmulator,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  authDomain: "home.kirkl.in",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

if (import.meta.env.DEV) {
  connectAuthEmulator(auth, "http://localhost:9099");
  connectFirestoreEmulator(db, "localhost", 8180);
}
