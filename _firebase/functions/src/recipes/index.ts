/**
 * Recipe-related cloud functions.
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Recipe, WithContext } from "schema-dts";
import axios from "axios";
import * as jsdom from "jsdom";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

import { db } from "../firebase";
import { corsOptions } from "../utils/cors";
import {
  anthropicApiKey,
  CLAUDE_MODEL,
  createAnthropicClient,
  parseAIResponse,
  normalizeTags,
  GENERATE_RECIPE_SYSTEM_PROMPT,
  buildEnrichmentPrompt,
  buildModificationPrompt,
} from "../utils/ai";

type RecipeWithContext = WithContext<Recipe>;

interface RecipeDocData {
  data?: Recipe;
  enrichmentStatus?: string;
  created?: Timestamp;
}

function isRecipeDocData(data: unknown): data is RecipeDocData {
  if (!data || typeof data !== "object") return false;
  const doc = data as Record<string, unknown>;
  return doc.data === undefined || typeof doc.data === "object";
}

function getRecipeFromDoc(data: unknown): Recipe | null {
  if (!isRecipeDocData(data)) return null;
  return data.data || null;
}

// ===== Recipe Scraping =====

export function getRecipesFromPage(doc: Document, url: string): Recipe[] {
  const recipes: Recipe[] = [];
  const schemas = doc.querySelectorAll('script[type="application/ld+json"]');
  if (schemas === null) {
    return recipes;
  }

  function isGraph(elt: Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(elt, "@graph")) {
      return true;
    }
    return false;
  }

  function isRecipe(elt: RecipeWithContext) {
    if (
      !(
        Object.prototype.hasOwnProperty.call(elt, "@context") &&
        Object.prototype.hasOwnProperty.call(elt, "@type")
      )
    ) {
      console.debug("no type or context");
      return false;
    }
    if (
      elt["@context"].toString().match(/recipe.org/) ||
      (elt["@type"] !== "Recipe" && elt["@type"][0] !== "Recipe")
    ) {
      console.debug("wrong type or context");
      return false;
    }
    console.debug("found recipe");
    return true;
  }

  for (let index = 0; index < schemas.length; index++) {
    const schema = schemas[index];

    if (schema.textContent === null) {
      continue;
    }

    let ldjson = JSON.parse(schema.textContent);
    if (isGraph(ldjson)) {
      ldjson = ldjson["@graph"];
    }
    if (Array.isArray(ldjson)) {
      ldjson.forEach((element: RecipeWithContext) => {
        if (isRecipe(element)) {
          element.url = url;
          recipes.push(element);
        }
      });
    } else if (isRecipe(ldjson)) {
      ldjson.url = url;
      recipes.push(ldjson);
    }
  }

  return recipes;
}

export const getRecipes = onCall(corsOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to import recipes");
  }
  const url = request.data.url;
  if (url === undefined || typeof url !== "string" || !url.trim()) {
    throw new HttpsError("invalid-argument", "Must specify a valid URL");
  }
  const tpc = await axios.get(request.data.url);
  const htmlDom = new jsdom.JSDOM(tpc.data);
  const recipes = getRecipesFromPage(htmlDom.window.document, url);
  return { recipes: JSON.stringify(recipes) };
});

// ===== Owner Management =====

async function updateOwners(
  docRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>,
  newOwnerEmail: string
): Promise<void> {
  const auth = getAuth();

  try {
    const user = await auth.getUserByEmail(newOwnerEmail);
    await docRef.update({ owners: FieldValue.arrayUnion(user.uid) });
  } catch (error: unknown) {
    const authError = error && typeof error === "object" && "code" in error
      ? (error as { code: string })
      : null;
    if (authError?.code === "auth/user-not-found") {
      try {
        const newUser = await auth.createUser({ email: newOwnerEmail });
        await docRef.update({ owners: FieldValue.arrayUnion(newUser.uid) });
      } catch (createError) {
        throw new HttpsError(
          "internal",
          "Unable to find or create user for provided email address.",
          createError
        );
      }
    } else {
      throw new HttpsError(
        "internal",
        "Unable to find account for provided email address.",
        error
      );
    }
  }
}

export const addRecipeOwner = onCall(corsOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to add recipe owner");
  }
  const { recipeId, boxId, newOwnerEmail } = request.data;
  const docRef = db.doc(`boxes/${boxId}/recipes/${recipeId}`);
  const recipe = (await docRef.get()).data();
  if (recipe === undefined) {
    throw new HttpsError("not-found", "Specified recipe does not exist");
  }
  await updateOwners(docRef, newOwnerEmail);
});

export const addBoxOwner = onCall(corsOptions, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to add box owner");
  }
  const { boxId, newOwnerEmail } = request.data;
  const docRef = db.doc(`boxes/${boxId}`);
  const box = (await docRef.get()).data();
  if (box === undefined) {
    throw new HttpsError("not-found", "Specified box does not exist");
  }
  await updateOwners(docRef, newOwnerEmail);
});

// ===== AI Recipe Generation =====

export const generateRecipe = onCall(
  {
    secrets: [anthropicApiKey],
    ...corsOptions,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in to generate recipes");
    }

    const { prompt } = request.data;
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError("invalid-argument", "Must provide a prompt");
    }

    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("internal", "API key not configured");
    }

    const anthropic = createAnthropicClient(apiKey);

    try {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: `Create a recipe for: ${prompt}` }],
        system: GENERATE_RECIPE_SYSTEM_PROMPT,
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";

      let recipe: Recipe;
      try {
        recipe = parseAIResponse<Recipe>(text);

        // Ensure tags are lowercase
        if (recipe.recipeCategory && Array.isArray(recipe.recipeCategory)) {
          recipe.recipeCategory = normalizeTags(recipe.recipeCategory as string[]);
        }
      } catch (parseError) {
        console.error("Failed to parse recipe response:", text.substring(0, 500));
        throw new HttpsError("internal", "Failed to parse recipe from AI response");
      }

      return { recipeJson: JSON.stringify(recipe) };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error("Error generating recipe:", error);
      throw new HttpsError("internal", "Failed to generate recipe");
    }
  }
);

// ===== AI Recipe Enrichment =====

interface EnrichmentResponse {
  description?: string;
  suggestedTags?: string[];
  stepIngredients?: string[][];
  reasoning?: string;
}

export const enrichRecipeManual = onCall(
  {
    secrets: [anthropicApiKey],
    ...corsOptions,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { boxId, recipeId } = request.data;
    if (!boxId || !recipeId) {
      throw new HttpsError("invalid-argument", "Must provide boxId and recipeId");
    }

    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("internal", "API key not configured");
    }

    const recipeDoc = await db.doc(`boxes/${boxId}/recipes/${recipeId}`).get();
    if (!recipeDoc.exists) {
      throw new HttpsError("not-found", "Recipe not found");
    }

    const recipe = getRecipeFromDoc(recipeDoc.data());
    if (!recipe) {
      throw new HttpsError("internal", "Recipe data is missing or invalid");
    }

    const ingredients = Array.isArray(recipe.recipeIngredient)
      ? recipe.recipeIngredient
      : [];
    const instructions = Array.isArray(recipe.recipeInstructions)
      ? recipe.recipeInstructions.map(
          (i: { text?: string } | string, idx: number) =>
            `Step ${idx + 1}: ${typeof i === "string" ? i : i.text || ""}`
        )
      : [];

    const anthropic = createAnthropicClient(apiKey);
    const enrichmentPrompt = buildEnrichmentPrompt(
      recipe.name?.toString() || "Unknown",
      ingredients,
      instructions,
      recipe.description?.toString()
    );

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: enrichmentPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    let enrichment: EnrichmentResponse;
    try {
      enrichment = parseAIResponse<EnrichmentResponse>(text);
    } catch (parseError) {
      console.error(`Failed to parse enrichment for ${recipeId}:`, text.substring(0, 500));
      throw new HttpsError("internal", "Failed to parse enrichment response");
    }

    enrichment.suggestedTags = normalizeTags(enrichment.suggestedTags);

    // Convert stepIngredients from array of arrays to object
    const stepIngredientsObj: Record<string, string[]> = {};
    if (Array.isArray(enrichment.stepIngredients)) {
      enrichment.stepIngredients.forEach((ingredients: string[], idx: number) => {
        stepIngredientsObj[idx.toString()] = Array.isArray(ingredients)
          ? ingredients
          : [];
      });
    }

    const pendingChanges = {
      data: {
        description: enrichment.description || "",
        recipeCategory: enrichment.suggestedTags || [],
      },
      stepIngredients: stepIngredientsObj,
      source: "enrichment",
      reasoning: enrichment.reasoning || "",
      generatedAt: Timestamp.now(),
      model: CLAUDE_MODEL,
    };

    await recipeDoc.ref.update({
      pendingChanges,
      enrichmentStatus: "pending",
    });

    return { success: true, modification: pendingChanges };
  }
);

// ===== AI Recipe Modification =====

interface ModificationResponse {
  modifiedRecipe?: {
    name?: string;
    description?: string;
    recipeIngredient?: string[];
    recipeInstructions?: Array<{ text: string }>;
  };
  reasoning?: string;
}

export const modifyRecipe = onCall(
  {
    secrets: [anthropicApiKey],
    ...corsOptions,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { boxId, recipeId, feedback } = request.data;
    if (!boxId || !recipeId || !feedback) {
      throw new HttpsError(
        "invalid-argument",
        "Must provide boxId, recipeId, and feedback"
      );
    }

    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("internal", "API key not configured");
    }

    const recipeDoc = await db.doc(`boxes/${boxId}/recipes/${recipeId}`).get();
    if (!recipeDoc.exists) {
      throw new HttpsError("not-found", "Recipe not found");
    }

    const recipe = getRecipeFromDoc(recipeDoc.data());
    if (!recipe) {
      throw new HttpsError("internal", "Recipe data is missing or invalid");
    }

    const ingredients = Array.isArray(recipe.recipeIngredient)
      ? (recipe.recipeIngredient as string[])
      : [];
    const instructions = Array.isArray(recipe.recipeInstructions)
      ? (recipe.recipeInstructions as Array<{ text?: string } | string>).map((i) =>
          typeof i === "string" ? i : i.text || ""
        )
      : [];

    const anthropic = createAnthropicClient(apiKey);
    const modificationPrompt = buildModificationPrompt(
      recipe.name?.toString() || "Unknown",
      recipe.description?.toString(),
      ingredients,
      instructions,
      feedback
    );

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      messages: [{ role: "user", content: modificationPrompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";

    let modification: ModificationResponse;
    try {
      modification = parseAIResponse<ModificationResponse>(text);
    } catch (parseError) {
      console.error(`Failed to parse modification for ${recipeId}:`, text.substring(0, 500));
      throw new HttpsError("internal", "Failed to parse modification response");
    }

    const now = Timestamp.now();
    const pendingChanges = {
      data: {
        name: modification.modifiedRecipe?.name,
        description: modification.modifiedRecipe?.description,
        recipeIngredient:
          modification.modifiedRecipe?.recipeIngredient || ingredients,
        recipeInstructions:
          modification.modifiedRecipe?.recipeInstructions ||
          instructions.map((text) => ({ text })),
      },
      source: "modification",
      prompt: feedback,
      reasoning: modification.reasoning || "",
      generatedAt: now,
      model: CLAUDE_MODEL,
    };

    await recipeDoc.ref.update({ pendingChanges });

    return {
      success: true,
      modification: {
        ...pendingChanges,
        generatedAt: now.toDate().toISOString(),
      },
    };
  }
);

// ===== Scheduled Enrichment =====

const ENRICHMENT_DELAY_MINUTES = 5;
const ENRICHMENT_BATCH_SIZE = 10;

export const enrichRecipes = onSchedule(
  {
    schedule: "every 10 minutes",
    secrets: [anthropicApiKey],
  },
  async () => {
    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      console.error("Anthropic API key not configured");
      return;
    }

    // Find recipes that need enrichment and were created more than 5 minutes ago
    const cutoffTime = Timestamp.fromDate(
      new Date(Date.now() - ENRICHMENT_DELAY_MINUTES * 60 * 1000)
    );

    const recipesSnapshot = await db
      .collectionGroup("recipes")
      .where("enrichmentStatus", "==", "needed")
      .where("created", "<", cutoffTime)
      .limit(ENRICHMENT_BATCH_SIZE)
      .get();

    if (recipesSnapshot.empty) {
      console.log("No recipes need enrichment");
      return;
    }

    console.log(`Found ${recipesSnapshot.size} recipes to enrich`);

    const anthropic = createAnthropicClient(apiKey);

    for (const recipeDoc of recipesSnapshot.docs) {
      try {
        const recipe = getRecipeFromDoc(recipeDoc.data());
        if (!recipe) {
          console.warn(`Skipping ${recipeDoc.id} - invalid recipe data`);
          continue;
        }

        // Skip if recipe already has description and tags
        const hasDescription =
          recipe.description && String(recipe.description).trim();
        const hasTags =
          recipe.recipeCategory &&
          (Array.isArray(recipe.recipeCategory)
            ? recipe.recipeCategory.length > 0
            : true);

        if (hasDescription && hasTags) {
          await recipeDoc.ref.update({ enrichmentStatus: "skipped" });
          console.log(`Skipped ${recipe.name} - already has content`);
          continue;
        }

        const ingredients = Array.isArray(recipe.recipeIngredient)
          ? recipe.recipeIngredient
          : [];
        const instructions = Array.isArray(recipe.recipeInstructions)
          ? recipe.recipeInstructions.map(
              (i: { text?: string } | string, idx: number) =>
                `Step ${idx + 1}: ${typeof i === "string" ? i : i.text || ""}`
            )
          : [];

        const enrichmentPrompt = buildEnrichmentPrompt(
          recipe.name?.toString() || "Unknown",
          ingredients,
          instructions,
          recipe.description?.toString()
        );

        const response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 2000,
          messages: [{ role: "user", content: enrichmentPrompt }],
        });

        const text =
          response.content[0].type === "text" ? response.content[0].text : "";

        let enrichment: EnrichmentResponse;
        try {
          enrichment = parseAIResponse<EnrichmentResponse>(text);
        } catch {
          console.error(`Failed to parse enrichment for ${recipe.name}:`, text);
          continue;
        }

        enrichment.suggestedTags = normalizeTags(enrichment.suggestedTags);

        // Convert stepIngredients from array of arrays to object
        const stepIngredientsObj: Record<string, string[]> = {};
        if (Array.isArray(enrichment.stepIngredients)) {
          enrichment.stepIngredients.forEach(
            (ingredients: string[], idx: number) => {
              stepIngredientsObj[idx.toString()] = Array.isArray(ingredients)
                ? ingredients
                : [];
            }
          );
        }

        await recipeDoc.ref.update({
          pendingChanges: {
            data: {
              description: enrichment.description || "",
              recipeCategory: enrichment.suggestedTags || [],
            },
            stepIngredients: stepIngredientsObj,
            source: "enrichment",
            reasoning: enrichment.reasoning || "",
            generatedAt: Timestamp.now(),
            model: CLAUDE_MODEL,
          },
          enrichmentStatus: "pending",
        });

        console.log(`Enriched ${recipe.name}`);
      } catch (error) {
        console.error(`Error enriching recipe ${recipeDoc.id}:`, error);
      }
    }
  }
);
