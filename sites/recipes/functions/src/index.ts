import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Recipe, WithContext } from "schema-dts";
import axios from 'axios';
import * as jsdom from 'jsdom';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { defineSecret } from "firebase-functions/params";
// Polyfill fetch globals for Anthropic SDK
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const nodeFetch = require('node-fetch');
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const FormData = require('form-data');
if (!globalThis.fetch) {
  globalThis.fetch = nodeFetch;
  globalThis.Headers = nodeFetch.Headers;
  globalThis.Request = nodeFetch.Request;
  globalThis.Response = nodeFetch.Response;
}
if (!globalThis.FormData) {
  globalThis.FormData = FormData;
}

const app = initializeApp();
const db = getFirestore(app);

// Define the secret
const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

type RecipeWithContext = WithContext<Recipe>

export function getRecipesFromPage(doc: Document, url: string): Recipe[] {
  const recipes: Recipe[] = [];
  // Pull ld+json metadata from the page and look for a recipe
  const schemas = doc.querySelectorAll('script[type="application/ld+json"]');
  if (schemas === null) {
    return recipes
  }

  function isGraph(elt: Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(elt, "@graph")) {
      /* the "graph" style ld+json puts objects at the root level, but
      cross-object references may be represented by simply referencing their ids.
      */
      return true
    }
    return false
  }

  function isRecipe(elt: RecipeWithContext) {
    if (!(Object.prototype.hasOwnProperty.call(elt, "@context") && Object.prototype.hasOwnProperty.call(elt, "@type"))) {
      console.debug("no type or context");
      return false;
    }
    if (elt["@context"].toString().match(/recipe.org/) || (elt["@type"] !== "Recipe" && elt["@type"][0] !== "Recipe")) {
      console.debug("wrong type or context");
      return false;
    }
    console.debug("found recipe")
    return true
  }

  for (let index = 0; index < schemas.length; index++) {
    const schema = schemas[index];

    if (schema.textContent === null) {
      continue
    }

    let ldjson = JSON.parse(schema.textContent);
    if (isGraph(ldjson)) {
      ldjson = ldjson["@graph"];
    }
    if (Array.isArray(ldjson)) {
      ldjson.forEach(
        (element: RecipeWithContext) => {
          if (isRecipe(element)) {
            element.url = url
            recipes.push(element)
          }
        }
      )
    } else if (isRecipe(ldjson)) {
      ldjson.url = url // maybe get rid of this
      recipes.push(ldjson);
    }
  }

  return recipes

}

export const getRecipes = onCall({
  cors: ["https://recipes.kirkl.in", "https://kirkl.in", "http://localhost:5000"],
  invoker: "public",
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to import recipes")
  }
  const url = request.data.url;
  if (url === undefined) {
    throw new HttpsError("invalid-argument", "must specify url")
  }
  const tpc = await axios.get(request.data.url)
  const htmlDom = new jsdom.JSDOM(tpc.data);
  const recipes = getRecipesFromPage(htmlDom.window.document, url)
  return { recipes: JSON.stringify(recipes) }
})

async function updateOwners(docRef: FirebaseFirestore.DocumentReference<FirebaseFirestore.DocumentData>, newOwnerEmail: string) {
  const auth = getAuth()
  auth.getUserByEmail(newOwnerEmail)
    .then((user) => {
      docRef.update({ owners: FieldValue.arrayUnion(user.uid) })
    })
    .catch((error) => {
      if (error.code === "auth/user-not-found") {

        auth.createUser({
          email: newOwnerEmail,
        })
          .then((user) => {
            docRef.update({ owners: FieldValue.arrayUnion(user.uid) })
          })
          .catch((error) => {
            throw new HttpsError("internal", "Unable to find or create user for provided email address.", error)
          })
      } else {
        throw new HttpsError("internal", "Unable to find account for provided email address.", error)
      }
    })
}

export const addRecipeOwner = onCall({
  cors: ["https://recipes.kirkl.in", "https://kirkl.in", "http://localhost:5000"],
  invoker: "public",
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to add recipe owner")
  }
  const { recipeId, boxId, newOwnerEmail } = request.data;
  const docRef = db.doc(`boxes/${boxId}/recipes/${recipeId}`)
  const recipe = (await docRef.get()).data()
  if (recipe === undefined) {
    throw new HttpsError("not-found", "Specified recipe does not exist")
  }
  updateOwners(docRef, newOwnerEmail)
})


export const addBoxOwner = onCall({
  cors: ["https://recipes.kirkl.in", "https://kirkl.in", "http://localhost:5000"],
  invoker: "public",
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in to add box owner")
  }
  const { boxId, newOwnerEmail } = request.data;
  const docRef = db.doc(`boxes/${boxId}`)
  const box = (await docRef.get()).data()
  if (box === undefined) {
    throw new HttpsError("not-found", "Specified box does not exist")
  }
  updateOwners(docRef, newOwnerEmail)
})

// Generate a recipe using Claude
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-5-20251101";

export const generateRecipe = onCall(
  {
    secrets: [anthropicApiKey],
    cors: ["https://recipes.kirkl.in", "https://kirkl.in", "http://localhost:5000"],
    invoker: "public",
  },
  async (request) => {
    // Require authentication
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in to generate recipes")
    }

    const { prompt } = request.data;
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError("invalid-argument", "Must provide a prompt")
    }

    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("internal", "API key not configured")
    }

    const anthropic = new Anthropic({ apiKey });

    const systemPrompt = `You are a helpful cooking assistant that generates recipes. When given a description of what the user wants, create a complete recipe.

Return ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "@type": "Recipe",
  "name": "Recipe Name",
  "description": "A brief, appetizing description of the dish",
  "recipeIngredient": ["ingredient 1", "ingredient 2", ...],
  "recipeInstructions": [
    {"@type": "HowToStep", "text": "Step 1 instructions"},
    {"@type": "HowToStep", "text": "Step 2 instructions"},
    ...
  ],
  "recipeCategory": ["category1", "category2"],
  "recipeYield": "4 servings",
  "prepTime": "PT15M",
  "cookTime": "PT30M"
}

Guidelines:
- Use clear, concise ingredient measurements
- Write instructions as complete sentences
- Include relevant categories (cuisine type, meal type, dietary info)
- Be creative but practical`;

    try {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 2000,
        messages: [
          { role: "user", content: `Create a recipe for: ${prompt}` }
        ],
        system: systemPrompt,
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";

      // Parse the JSON response
      let recipe: Recipe;
      try {
        // Handle potential markdown code blocks
        let jsonStr = text.trim();
        if (jsonStr.startsWith("```")) {
          jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }
        recipe = JSON.parse(jsonStr);

        // Ensure tags are lowercase
        if (recipe.recipeCategory && Array.isArray(recipe.recipeCategory)) {
          recipe.recipeCategory = recipe.recipeCategory.map((t: string) => t.toLowerCase());
        }
      } catch {
        throw new HttpsError("internal", "Failed to parse recipe from AI response")
      }

      // Return as JSON string to avoid Firebase SDK decode issues with nested objects
      return { recipeJson: JSON.stringify(recipe) };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error("Error generating recipe:", error);
      throw new HttpsError("internal", "Failed to generate recipe")
    }
  }
)

// Scheduled function to enrich recipes that need it
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

    const anthropic = new Anthropic({ apiKey });

    for (const recipeDoc of recipesSnapshot.docs) {
      try {
        const recipeData = recipeDoc.data();
        const recipe = recipeData.data as Recipe;

        // Skip if recipe already has description and tags
        const hasDescription = recipe.description && String(recipe.description).trim();
        const hasTags = recipe.recipeCategory &&
          (Array.isArray(recipe.recipeCategory) ? recipe.recipeCategory.length > 0 : true);

        if (hasDescription && hasTags) {
          // Already has content, mark as skipped
          await recipeDoc.ref.update({ enrichmentStatus: "skipped" });
          console.log(`Skipped ${recipe.name} - already has content`);
          continue;
        }

        // Build context from recipe
        const ingredients = Array.isArray(recipe.recipeIngredient)
          ? recipe.recipeIngredient.join(", ")
          : "";
        const instructions = Array.isArray(recipe.recipeInstructions)
          ? recipe.recipeInstructions.map((i: { text?: string } | string) =>
              typeof i === 'string' ? i : i.text || ''
            ).join(" ")
          : "";

        const enrichmentPrompt = `Analyze this recipe and provide enrichment data.

Recipe Name: ${recipe.name || "Unknown"}
Ingredients: ${ingredients}
Instructions: ${instructions}
${recipe.description ? `Existing Description: ${recipe.description}` : ""}

Return ONLY valid JSON (no markdown) with:
{
  "description": "A brief, appetizing 1-2 sentence description of the dish",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "reasoning": "Brief explanation of why you chose these tags"
}

Tags should be lowercase and include: cuisine type, meal type, main protein/ingredient, cooking method, dietary info if applicable. Aim for 3-6 relevant tags.`;

        const response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 500,
          messages: [{ role: "user", content: enrichmentPrompt }],
        });

        const text = response.content[0].type === "text" ? response.content[0].text : "";

        let enrichment;
        try {
          let jsonStr = text.trim();
          if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
          }
          enrichment = JSON.parse(jsonStr);
        } catch {
          console.error(`Failed to parse enrichment for ${recipe.name}:`, text);
          continue;
        }

        // Ensure tags are lowercase
        if (enrichment.suggestedTags && Array.isArray(enrichment.suggestedTags)) {
          enrichment.suggestedTags = enrichment.suggestedTags.map((t: string) => t.toLowerCase());
        }

        // Save pending enrichment
        await recipeDoc.ref.update({
          pendingEnrichment: {
            description: enrichment.description || "",
            suggestedTags: enrichment.suggestedTags || [],
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
)
