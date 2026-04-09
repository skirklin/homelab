/**
 * Firebase/Firestore implementation of RecipesBackend.
 *
 * Data model (Firestore):
 *   users/{userId}                      — user profile with boxes (array of doc refs)
 *   boxes/{boxId}                       — recipe box metadata
 *   boxes/{boxId}/recipes/{recipeId}    — recipe data
 *   boxes/{boxId}/events/{eventId}      — cooking log events
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  deleteField,
  onSnapshot,
  query,
  where,
  orderBy,
  arrayUnion,
  arrayRemove,
  Timestamp,
  type Firestore,
  type DocumentReference,
} from "firebase/firestore";
import type { RecipesBackend, RecipesUser } from "../interfaces/recipes";
import type { RecipeBox, Recipe, RecipeData, PendingChanges, CookingLogEvent } from "../types/recipes";
import type { Visibility, Unsubscribe } from "../types/common";

export class FirebaseRecipesBackend implements RecipesBackend {
  constructor(private db: Firestore) {}

  // --- User ---

  async getUser(userId: string): Promise<RecipesUser | null> {
    const snap = await getDoc(doc(this.db, "users", userId));
    if (!snap.exists()) return null;
    const data = snap.data();
    // Firebase stores boxes as document references; extract IDs
    const boxRefs: DocumentReference[] = data.boxes || [];
    return {
      id: snap.id,
      boxes: boxRefs.map((ref) => (typeof ref === "string" ? ref : ref.id)),
      cookingModeSeen: !!data.cookingModeSeen,
      lastSeenUpdateVersion: data.lastSeenUpdateVersion || 0,
    };
  }

  async setCookingModeSeen(userId: string): Promise<void> {
    await updateDoc(doc(this.db, "users", userId), { cookingModeSeen: true });
  }

  async setLastSeenUpdateVersion(userId: string, version: number): Promise<void> {
    await updateDoc(doc(this.db, "users", userId), { lastSeenUpdateVersion: version });
  }

  // --- Box CRUD ---

  async createBox(userId: string, name: string): Promise<string> {
    const boxRef = await addDoc(collection(this.db, "boxes"), {
      name,
      owners: [userId],
      visibility: "private",
      creator: userId,
      updated: Timestamp.now(),
    });
    await updateDoc(doc(this.db, "users", userId), {
      boxes: arrayUnion(boxRef),
    });
    return boxRef.id;
  }

  async deleteBox(boxId: string): Promise<void> {
    await deleteDoc(doc(this.db, "boxes", boxId));
  }

  async setBoxVisibility(boxId: string, visibility: Visibility): Promise<void> {
    await updateDoc(doc(this.db, "boxes", boxId), { visibility });
  }

  async subscribeToBox(userId: string, boxId: string): Promise<void> {
    const boxRef = doc(this.db, "boxes", boxId);
    await updateDoc(doc(this.db, "users", userId), { boxes: arrayUnion(boxRef) });
    await updateDoc(boxRef, { subscribers: arrayUnion(userId) });
  }

  async unsubscribeFromBox(userId: string, boxId: string): Promise<void> {
    const boxRef = doc(this.db, "boxes", boxId);
    await updateDoc(doc(this.db, "users", userId), { boxes: arrayRemove(boxRef) });
    await updateDoc(boxRef, { subscribers: arrayRemove(userId) });
  }

  // --- Recipe CRUD ---

  async getBox(boxId: string, userId: string | null): Promise<{ box: RecipeBox; recipes: Recipe[] } | null> {
    const snap = await getDoc(doc(this.db, "boxes", boxId));
    if (!snap.exists()) return null;
    const data = snap.data();
    const box: RecipeBox = {
      id: snap.id,
      name: data.name || "",
      description: data.description || "",
      owners: data.owners || [],
      subscribers: data.subscribers || [],
      visibility: data.visibility || "private",
    };

    const recipes: Recipe[] = [];
    if (userId) {
      const recipesSnap = await getDocs(collection(this.db, "boxes", boxId, "recipes"));
      for (const d of recipesSnap.docs) {
        recipes.push(this.recipeFromDoc(d.id, boxId, d.data()));
      }
    }
    return { box, recipes };
  }

  async addRecipe(boxId: string, data: RecipeData, userId: string): Promise<string> {
    const ref = await addDoc(collection(this.db, "boxes", boxId, "recipes"), {
      data,
      owners: [userId],
      visibility: "private",
      creator: userId,
      enrichmentStatus: "needed",
      updated: Timestamp.now(),
    });
    return ref.id;
  }

  async saveRecipe(recipeId: string, data: RecipeData, userId: string): Promise<void> {
    // Need boxId — use _activeBoxId from subscription
    await updateDoc(doc(this.db, "boxes", this._activeBoxId, "recipes", recipeId), {
      data,
      enrichmentStatus: "needed",
      pendingChanges: deleteField(),
      lastUpdatedBy: userId,
      updated: Timestamp.now(),
    });
  }

  async deleteRecipe(recipeId: string): Promise<void> {
    await deleteDoc(doc(this.db, "boxes", this._activeBoxId, "recipes", recipeId));
  }

  async setRecipeVisibility(recipeId: string, visibility: Visibility): Promise<void> {
    await updateDoc(doc(this.db, "boxes", this._activeBoxId, "recipes", recipeId), { visibility });
  }

  // --- Enrichment ---

  async applyChanges(
    recipeId: string,
    changes: PendingChanges,
    currentRecipe?: { description?: string; tags?: string[] },
  ): Promise<void> {
    const recipeRef = doc(this.db, "boxes", this._activeBoxId, "recipes", recipeId);
    const updates: Record<string, unknown> = {
      pendingChanges: deleteField(),
      updated: Timestamp.now(),
    };

    if (changes.data) {
      if (changes.data.name) updates["data.name"] = changes.data.name;
      if (changes.data.description) {
        if (changes.source === "modification" || !currentRecipe?.description?.trim()) {
          updates["data.description"] = changes.data.description;
        }
      }
      if (changes.data.recipeIngredient) updates["data.recipeIngredient"] = changes.data.recipeIngredient;
      if (changes.data.recipeInstructions) updates["data.recipeInstructions"] = changes.data.recipeInstructions;
      if (changes.data.recipeCategory) {
        const existing = currentRecipe?.tags || [];
        updates["data.recipeCategory"] = [...new Set([...existing, ...changes.data.recipeCategory].map((t) => t.toLowerCase()))];
      }
    }

    if (changes.stepIngredients && Object.keys(changes.stepIngredients).length > 0) {
      updates.stepIngredients = changes.stepIngredients;
    }
    updates.enrichmentStatus = changes.source === "enrichment" ? "done" : "needed";

    await updateDoc(recipeRef, updates);
  }

  async rejectChanges(recipeId: string, source?: string): Promise<void> {
    const updates: Record<string, unknown> = { pendingChanges: deleteField() };
    if (source === "enrichment") updates.enrichmentStatus = "skipped";
    await updateDoc(doc(this.db, "boxes", this._activeBoxId, "recipes", recipeId), updates);
  }

  // --- Cooking log ---

  async getCookingLogEvents(boxId: string, recipeId: string): Promise<CookingLogEvent[]> {
    const q = query(
      collection(this.db, "boxes", boxId, "events"),
      where("subjectId", "==", recipeId),
      orderBy("timestamp", "desc"),
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => {
      const data = d.data();
      return {
        id: d.id,
        subjectId: data.subjectId,
        timestamp: data.timestamp?.toDate?.() || new Date(),
        createdAt: data.createdAt?.toDate?.() || new Date(),
        createdBy: data.createdBy || "",
        data: data.data || {},
      };
    });
  }

  async addCookingLogEvent(boxId: string, recipeId: string, userId: string, notes?: string): Promise<string> {
    const now = Timestamp.now();
    const ref = await addDoc(collection(this.db, "boxes", boxId, "events"), {
      subjectId: recipeId,
      timestamp: now,
      createdAt: now,
      createdBy: userId,
      data: notes ? { notes } : {},
    });
    return ref.id;
  }

  async updateCookingLogEvent(eventId: string, notes: string): Promise<void> {
    // Need to find which box this event belongs to — use _activeBoxId
    const ref = doc(this.db, "boxes", this._activeBoxId, "events", eventId);
    const trimmed = notes.trim();
    if (trimmed) {
      await updateDoc(ref, { "data.notes": trimmed });
    } else {
      await updateDoc(ref, { "data.notes": deleteField() });
    }
  }

  async deleteCookingLogEvent(eventId: string): Promise<void> {
    await deleteDoc(doc(this.db, "boxes", this._activeBoxId, "events", eventId));
  }

  // --- Subscriptions ---

  private _activeBoxId = "";

  subscribeToUser(
    userId: string,
    handlers: {
      onUser: (user: RecipesUser) => void;
      onBox: (box: RecipeBox, recipes: Recipe[]) => void;
      onBoxRemoved: (boxId: string) => void;
      onRecipeChanged: (boxId: string, recipe: Recipe) => void;
      onRecipeRemoved: (boxId: string, recipeId: string) => void;
    },
  ): Unsubscribe {
    const unsubs: Array<() => void> = [];
    const boxUnsubs = new Map<string, Array<() => void>>();

    const setupBox = (boxId: string) => {
      if (boxUnsubs.has(boxId)) return;
      const subs: Array<() => void> = [];
      boxUnsubs.set(boxId, subs);
      this._activeBoxId = boxId;

      // Box metadata
      subs.push(
        onSnapshot(doc(this.db, "boxes", boxId), (snap) => {
          if (!snap.exists()) {
            handlers.onBoxRemoved(boxId);
            return;
          }
          const data = snap.data();
          const box: RecipeBox = {
            id: snap.id,
            name: data.name || "",
            description: data.description || "",
            owners: data.owners || [],
            subscribers: data.subscribers || [],
            visibility: data.visibility || "private",
          };
          // On first load, also fetch recipes
          getDocs(collection(this.db, "boxes", boxId, "recipes")).then((recipesSnap) => {
            const recipes = recipesSnap.docs.map((d) => this.recipeFromDoc(d.id, boxId, d.data()));
            handlers.onBox(box, recipes);
          });
        }),
      );

      // Recipes realtime
      subs.push(
        onSnapshot(collection(this.db, "boxes", boxId, "recipes"), (snapshot) => {
          snapshot.docChanges().forEach((change) => {
            if (change.type === "removed") {
              handlers.onRecipeRemoved(boxId, change.doc.id);
            } else {
              handlers.onRecipeChanged(boxId, this.recipeFromDoc(change.doc.id, boxId, change.doc.data()));
            }
          });
        }),
      );
    };

    // User document — contains box references
    unsubs.push(
      onSnapshot(doc(this.db, "users", userId), (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        const boxRefs: DocumentReference[] = data.boxes || [];
        const user: RecipesUser = {
          id: snap.id,
          boxes: boxRefs.map((ref) => (typeof ref === "string" ? ref : ref.id)),
          cookingModeSeen: !!data.cookingModeSeen,
          lastSeenUpdateVersion: data.lastSeenUpdateVersion || 0,
        };
        handlers.onUser(user);
        for (const boxId of user.boxes) {
          setupBox(boxId);
        }
      }),
    );

    return () => {
      unsubs.forEach((u) => u());
      for (const subs of boxUnsubs.values()) {
        subs.forEach((u) => u());
      }
      boxUnsubs.clear();
    };
  }

  private recipeFromDoc(id: string, boxId: string, data: Record<string, unknown>): Recipe {
    return {
      id,
      box: boxId,
      data: (data.data || {}) as RecipeData,
      owners: (data.owners as string[]) || [],
      visibility: (data.visibility as Visibility) || "private",
      enrichmentStatus: (data.enrichmentStatus as Recipe["enrichmentStatus"]) || "needed",
      pendingChanges: (data.pendingChanges as PendingChanges) || null,
      stepIngredients: (data.stepIngredients as Record<string, string[]>) || null,
      cookingLog: data.cookingLog || null,
    };
  }
}
