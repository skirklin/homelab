import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from "firebase/auth";
import { getFirestore, connectFirestoreEmulator, enableIndexedDbPersistence } from "firebase/firestore";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";


// Configure Firebase.
const firebaseConfig = {
  apiKey: "AIzaSyDnTpynPmWemzfi-AHzPEgu2TqZ0e-8UUA",
  authDomain: "recipes.kirkl.in",
  projectId: "recipe-box-335721",
  storageBucket: "recipe-box-335721.appspot.com",
  messagingSenderId: "779965064363",
  appId: "1:779965064363:web:78d754d6591b130cdb83ee",
  // measurementId: "G-ZWWFPLHJHE"
};

export const app = initializeApp(firebaseConfig);

// setup auth emulator
const auth = getAuth(app);
if (process.env.NODE_ENV === "development") {
  connectAuthEmulator(auth, "http://localhost:9099");
}

// setup firestore emulator
export const db = getFirestore(app);
if (process.env.NODE_ENV === "development") {
  connectFirestoreEmulator(db, 'localhost', 8080);
}

// Enable offline persistence
enableIndexedDbPersistence(db).catch((err) => {
  if (err.code === "failed-precondition") {
    console.warn("Offline persistence unavailable: multiple tabs open");
  } else if (err.code === "unimplemented") {
    console.warn("Offline persistence unavailable: browser not supported");
  }
});

const functions = getFunctions(app);
if (process.env.NODE_ENV === "development") {
  connectFunctionsEmulator(functions, "localhost", 5001);
}

export const getRecipes = httpsCallable(functions, 'getRecipes');
export const addBoxOwner = httpsCallable(functions, 'addBoxOwner');
export const addRecipeOwner = httpsCallable(functions, 'addRecipeOwner');
export const generateRecipe = httpsCallable<{ prompt: string }, { recipeJson: string }>(functions, 'generateRecipe');