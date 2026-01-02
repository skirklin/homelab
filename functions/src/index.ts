import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { Recipe, WithContext } from "schema-dts";
import axios from 'axios';
import * as jsdom from 'jsdom';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
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

// Define secrets
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
  cors: ["https://recipes.kirkl.in", "https://home.kirkl.in", "https://kirkl.in", "http://localhost:5000", "http://localhost:5173"],
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
  cors: ["https://recipes.kirkl.in", "https://home.kirkl.in", "https://kirkl.in", "http://localhost:5000", "http://localhost:5173"],
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
  cors: ["https://recipes.kirkl.in", "https://home.kirkl.in", "https://kirkl.in", "http://localhost:5000", "http://localhost:5173"],
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
    cors: ["https://recipes.kirkl.in", "https://home.kirkl.in", "https://kirkl.in", "http://localhost:5000", "http://localhost:5173"],
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
    {"@type": "HowToStep", "text": "Step 1 instructions", "ingredients": ["ingredient with amount used in this step"]},
    {"@type": "HowToStep", "text": "Step 2 instructions", "ingredients": ["ingredient 1", "ingredient 2"]},
    ...
  ],
  "recipeCategory": ["category1", "category2"],
  "recipeYield": "4 servings",
  "prepTime": "PT15M",
  "cookTime": "PT30M",
  "notes": "Tips, variations, storage info, and serving suggestions"
}

Guidelines:
- Use clear, concise ingredient measurements
- Write instructions as complete sentences
- Include relevant categories (cuisine type, meal type, dietary info)
- Be creative but practical
- Notes should include: tips/variations, make-ahead/storage instructions, and serving suggestions
- Each step's ingredients array should list the specific ingredients (with amounts) used in that step
- If an ingredient is divided across steps, show the portion used in each step (e.g., "1 tbsp butter" in step 1, "2 tbsp butter" in step 3)`;

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

// Manually trigger enrichment for a specific recipe (for testing)
export const enrichRecipeManual = onCall(
  {
    secrets: [anthropicApiKey],
    cors: ["https://recipes.kirkl.in", "https://home.kirkl.in", "https://kirkl.in", "http://localhost:5000", "http://localhost:5173"],
    invoker: "public",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in")
    }

    const { boxId, recipeId } = request.data;
    if (!boxId || !recipeId) {
      throw new HttpsError("invalid-argument", "Must provide boxId and recipeId")
    }

    const apiKey = anthropicApiKey.value();
    if (!apiKey) {
      throw new HttpsError("internal", "API key not configured")
    }

    const recipeDoc = await db.doc(`boxes/${boxId}/recipes/${recipeId}`).get();
    if (!recipeDoc.exists) {
      throw new HttpsError("not-found", "Recipe not found")
    }

    const recipeData = recipeDoc.data()!;
    const recipe = recipeData.data as Recipe;

    const ingredients = Array.isArray(recipe.recipeIngredient)
      ? recipe.recipeIngredient
      : [];
    const instructions = Array.isArray(recipe.recipeInstructions)
      ? recipe.recipeInstructions.map((i: { text?: string } | string, idx: number) =>
          `Step ${idx + 1}: ${typeof i === 'string' ? i : i.text || ''}`
        )
      : [];

    const anthropic = new Anthropic({ apiKey });

    const enrichmentPrompt = `Analyze this recipe and provide enrichment data.

Recipe Name: ${recipe.name || "Unknown"}
Ingredients: ${JSON.stringify(ingredients)}
Instructions:
${instructions.join("\n")}
${recipe.description ? `Existing Description: ${recipe.description}` : ""}

Return ONLY valid JSON (no markdown) with:
{
  "description": "A brief, appetizing 1-2 sentence description of the dish",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "stepIngredients": [
    ["ingredient with amount for step 1", "another ingredient"],
    ["ingredients for step 2"],
    ...
  ],
  "reasoning": "Brief explanation of your analysis"
}

Guidelines:
- Tags should be lowercase: cuisine type, meal type, main protein/ingredient, cooking method, dietary info. Aim for 3-6 tags.
- stepIngredients must have exactly ${instructions.length} arrays (one per step)
- Each step's array lists the specific ingredients (with amounts) used in that step
- If an ingredient is divided across steps, show the portion in each step
- Steps with no ingredients (e.g., "let rest") should have an empty array []`;

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
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
      throw new HttpsError("internal", "Failed to parse enrichment response")
    }

    if (enrichment.suggestedTags && Array.isArray(enrichment.suggestedTags)) {
      enrichment.suggestedTags = enrichment.suggestedTags.map((t: string) => t.toLowerCase());
    }

    // Convert stepIngredients from array of arrays to object (Firestore doesn't support nested arrays)
    const stepIngredientsObj: Record<string, string[]> = {};
    if (Array.isArray(enrichment.stepIngredients)) {
      enrichment.stepIngredients.forEach((ingredients: string[], idx: number) => {
        stepIngredientsObj[idx.toString()] = Array.isArray(ingredients) ? ingredients : [];
      });
    }

    // Save pending enrichment
    await recipeDoc.ref.update({
      pendingEnrichment: {
        description: enrichment.description || "",
        suggestedTags: enrichment.suggestedTags || [],
        stepIngredients: stepIngredientsObj,
        reasoning: enrichment.reasoning || "",
        generatedAt: Timestamp.now(),
        model: CLAUDE_MODEL,
      },
      enrichmentStatus: "pending",
    });

    return { success: true, enrichment };
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
          ? recipe.recipeIngredient
          : [];
        const instructions = Array.isArray(recipe.recipeInstructions)
          ? recipe.recipeInstructions.map((i: { text?: string } | string, idx: number) =>
              `Step ${idx + 1}: ${typeof i === 'string' ? i : i.text || ''}`
            )
          : [];

        const enrichmentPrompt = `Analyze this recipe and provide enrichment data.

Recipe Name: ${recipe.name || "Unknown"}
Ingredients: ${JSON.stringify(ingredients)}
Instructions:
${instructions.join("\n")}
${recipe.description ? `Existing Description: ${recipe.description}` : ""}

Return ONLY valid JSON (no markdown) with:
{
  "description": "A brief, appetizing 1-2 sentence description of the dish",
  "suggestedTags": ["tag1", "tag2", "tag3"],
  "stepIngredients": [
    ["ingredient with amount for step 1", "another ingredient"],
    ["ingredients for step 2"],
    ...
  ],
  "reasoning": "Brief explanation of your analysis"
}

Guidelines:
- Tags should be lowercase: cuisine type, meal type, main protein/ingredient, cooking method, dietary info. Aim for 3-6 tags.
- stepIngredients must have exactly ${instructions.length} arrays (one per step)
- Each step's array lists the specific ingredients (with amounts) used in that step
- If an ingredient is divided across steps, show the portion in each step
- Steps with no ingredients (e.g., "let rest") should have an empty array []`;

        const response = await anthropic.messages.create({
          model: CLAUDE_MODEL,
          max_tokens: 2000,
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

        // Convert stepIngredients from array of arrays to object (Firestore doesn't support nested arrays)
        const stepIngredientsObj: Record<string, string[]> = {};
        if (Array.isArray(enrichment.stepIngredients)) {
          enrichment.stepIngredients.forEach((ingredients: string[], idx: number) => {
            stepIngredientsObj[idx.toString()] = Array.isArray(ingredients) ? ingredients : [];
          });
        }

        // Save pending enrichment
        await recipeDoc.ref.update({
          pendingEnrichment: {
            description: enrichment.description || "",
            suggestedTags: enrichment.suggestedTags || [],
            stepIngredients: stepIngredientsObj,
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

// ===== Household Task Notifications =====

interface TaskFrequency {
  value: number;
  unit: "days" | "weeks" | "months";
}

interface TaskData {
  name: string;
  frequency: TaskFrequency;
  lastCompleted: Timestamp | null;
  notifyUsers: string[];
}

function calculateDueDate(lastCompleted: Date, frequency: TaskFrequency): Date {
  const due = new Date(lastCompleted);
  switch (frequency.unit) {
    case "days":
      due.setDate(due.getDate() + frequency.value);
      break;
    case "weeks":
      due.setDate(due.getDate() + frequency.value * 7);
      break;
    case "months":
      due.setMonth(due.getMonth() + frequency.value);
      break;
  }
  return due;
}

function isDateToday(date: Date): boolean {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

// Run every 5 minutes for testing (change back to "0 8 * * *" for production)
export const sendHouseholdTaskNotifications = onSchedule(
  {
    schedule: "*/5 * * * *", // Every 5 minutes for testing
    timeZone: "America/Los_Angeles",
  },
  async () => {
    console.log("Starting household task notification check");

    const messaging = getMessaging();

    // Get all tasks from all task lists
    const tasksSnapshot = await db.collectionGroup("tasks").get();

    if (tasksSnapshot.empty) {
      console.log("No tasks found");
      return;
    }

    // Group notifications by user
    const userNotifications: Map<string, { taskName: string; listId: string }[]> = new Map();

    for (const taskDoc of tasksSnapshot.docs) {
      const task = taskDoc.data() as TaskData;

      // Skip if no one wants notifications for this task
      if (!task.notifyUsers || task.notifyUsers.length === 0) {
        continue;
      }

      // Calculate if task is due today
      let isDueToday = false;

      if (!task.lastCompleted) {
        // Never completed = overdue, should have been notified already
        // But notify if someone just subscribed
        isDueToday = true;
      } else {
        const dueDate = calculateDueDate(task.lastCompleted.toDate(), task.frequency);
        isDueToday = isDateToday(dueDate);
      }

      if (isDueToday) {
        // Extract list ID from path: taskLists/{listId}/tasks/{taskId}
        const listId = taskDoc.ref.parent.parent?.id || "unknown";

        for (const userId of task.notifyUsers) {
          if (!userNotifications.has(userId)) {
            userNotifications.set(userId, []);
          }
          userNotifications.get(userId)!.push({ taskName: task.name, listId });
        }
      }
    }

    console.log(`Found ${userNotifications.size} users with due tasks`);

    // Send notifications to each user
    for (const [userId, tasks] of userNotifications) {
      // Get user's FCM tokens
      const userDoc = await db.doc(`users/${userId}`).get();
      const userData = userDoc.data();

      if (!userData?.fcmTokens || userData.fcmTokens.length === 0) {
        console.log(`No FCM tokens for user ${userId}`);
        continue;
      }

      // Build notification message
      const taskCount = tasks.length;
      const title = taskCount === 1
        ? `${tasks[0].taskName} is due today`
        : `${taskCount} household tasks due today`;

      const body = taskCount === 1
        ? "Tap to view details"
        : tasks.slice(0, 3).map(t => t.taskName).join(", ") +
          (taskCount > 3 ? ` and ${taskCount - 3} more` : "");

      // Send to all tokens
      const tokens = userData.fcmTokens as string[];
      const invalidTokens: string[] = [];

      for (const token of tokens) {
        try {
          // Use data-only message to let service worker control notification display
          // (including notification payload causes FCM to auto-display, leading to duplicates)
          await messaging.send({
            token,
            webpush: {
              fcmOptions: {
                link: "https://upkeep.kirkl.in",
              },
            },
            data: {
              type: "household_task_due",
              title,
              body,
              taskCount: String(taskCount),
            },
          });
          console.log(`Sent notification to user ${userId}`);
        } catch (error: unknown) {
          const fcmError = error as { code?: string };
          if (fcmError.code === "messaging/registration-token-not-registered" ||
              fcmError.code === "messaging/invalid-registration-token") {
            invalidTokens.push(token);
          } else {
            console.error(`Error sending to user ${userId}:`, error);
          }
        }
      }

      // Clean up invalid tokens
      if (invalidTokens.length > 0) {
        await db.doc(`users/${userId}`).update({
          fcmTokens: FieldValue.arrayRemove(...invalidTokens),
        });
        console.log(`Removed ${invalidTokens.length} invalid tokens for user ${userId}`);
      }
    }

    console.log("Household task notification check complete");
  }
)

// ===== Life Tracker Random Sampling =====

interface SampleQuestion {
  id: string;
  type: "rating" | "text" | "number";
  label: string;
  max?: number;
}

interface RandomSamplesConfig {
  enabled: boolean;
  timesPerDay: number;
  activeHours: [number, number]; // [startHour, endHour]
  questions: SampleQuestion[];
}

interface LifeLogData {
  manifest?: {
    randomSamples?: RandomSamplesConfig;
  };
  sampleSchedule?: {
    date: string; // YYYY-MM-DD
    times: number[]; // Scheduled times as Unix timestamps
    sentTimes: number[]; // Already sent timestamps
  };
  owners: string[];
}

// Generate random sample times for a day
function generateSampleTimes(
  timesPerDay: number,
  activeHours: [number, number],
  date: Date
): number[] {
  const [startHour, endHour] = activeHours;
  const times: number[] = [];

  // Calculate the total minutes in the active window
  const totalMinutes = (endHour - startHour) * 60;

  // Generate evenly distributed times with some randomness
  const interval = totalMinutes / timesPerDay;

  for (let i = 0; i < timesPerDay; i++) {
    // Add randomness within the interval (±25%)
    const baseMinute = startHour * 60 + interval * i + interval / 2;
    const jitter = (Math.random() - 0.5) * interval * 0.5;
    const minute = Math.max(startHour * 60, Math.min(endHour * 60, baseMinute + jitter));

    const sampleTime = new Date(date);
    sampleTime.setHours(Math.floor(minute / 60), Math.round(minute % 60), 0, 0);
    times.push(sampleTime.getTime());
  }

  return times.sort((a, b) => a - b);
}

// Run every 5 minutes to check for sample notifications
export const sendLifeTrackerSamples = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: "America/Los_Angeles",
  },
  async () => {
    console.log("Starting life tracker sample check");

    const messaging = getMessaging();
    const now = Date.now();
    const today = new Date().toISOString().split("T")[0];

    // Get all life logs
    const logsSnapshot = await db.collection("lifeLogs").get();

    if (logsSnapshot.empty) {
      console.log("No life logs found");
      return;
    }

    for (const logDoc of logsSnapshot.docs) {
      const logData = logDoc.data() as LifeLogData;
      const config = logData.manifest?.randomSamples;

      // Skip if sampling not enabled
      if (!config?.enabled) {
        continue;
      }

      // Initialize or update schedule for today
      let schedule = logData.sampleSchedule;

      if (!schedule || schedule.date !== today) {
        // Generate new schedule for today
        const times = generateSampleTimes(
          config.timesPerDay,
          config.activeHours,
          new Date()
        );

        schedule = {
          date: today,
          times,
          sentTimes: [],
        };

        await logDoc.ref.update({ sampleSchedule: schedule });
        console.log(`Generated sample schedule for log ${logDoc.id}: ${times.length} times`);
      }

      // Check if any scheduled time has passed and hasn't been sent
      const pendingTimes = schedule.times.filter(
        (t) => t <= now && !schedule!.sentTimes.includes(t)
      );

      if (pendingTimes.length === 0) {
        continue;
      }

      console.log(`Log ${logDoc.id} has ${pendingTimes.length} pending samples`);

      // Get FCM tokens for all owners
      const ownerTokens: { userId: string; token: string }[] = [];

      for (const ownerId of logData.owners || []) {
        const userDoc = await db.doc(`users/${ownerId}`).get();
        const userData = userDoc.data();

        // Support both single token (fcmToken) and array (fcmTokens)
        if (userData?.fcmToken) {
          ownerTokens.push({ userId: ownerId, token: userData.fcmToken });
        }
        if (userData?.fcmTokens) {
          for (const token of userData.fcmTokens as string[]) {
            ownerTokens.push({ userId: ownerId, token });
          }
        }
      }

      if (ownerTokens.length === 0) {
        console.log(`No FCM tokens for log ${logDoc.id}`);
        // Still mark times as sent to avoid repeated attempts
        await logDoc.ref.update({
          "sampleSchedule.sentTimes": [...schedule.sentTimes, ...pendingTimes],
        });
        continue;
      }

      // Send notification to all owners
      const invalidTokens: string[] = [];
      const title = "Life Tracker Check-in";
      const body = config.questions.length === 1
        ? config.questions[0].label
        : `Answer ${config.questions.length} quick questions`;

      for (const { userId, token } of ownerTokens) {
        try {
          await messaging.send({
            token,
            webpush: {
              fcmOptions: {
                link: "https://home.kirkl.in/life?sample=true",
              },
            },
            data: {
              type: "life_tracker_sample",
              title,
              body,
              logId: logDoc.id,
            },
          });
          console.log(`Sent sample notification to user ${userId}`);
        } catch (error: unknown) {
          const fcmError = error as { code?: string };
          if (
            fcmError.code === "messaging/registration-token-not-registered" ||
            fcmError.code === "messaging/invalid-registration-token"
          ) {
            invalidTokens.push(token);
          } else {
            console.error(`Error sending to user ${userId}:`, error);
          }
        }
      }

      // Mark times as sent
      await logDoc.ref.update({
        "sampleSchedule.sentTimes": [...schedule.sentTimes, ...pendingTimes],
      });

      // Clean up invalid tokens (for users with single token)
      for (const token of invalidTokens) {
        const ownerInfo = ownerTokens.find((o) => o.token === token);
        if (ownerInfo) {
          await db.doc(`users/${ownerInfo.userId}`).update({
            fcmToken: FieldValue.delete(),
          });
          console.log(`Removed invalid token for user ${ownerInfo.userId}`);
        }
      }
    }

    console.log("Life tracker sample check complete");
  }
)

// ============================================
// Migration: cookingLog arrays to events subcollection
// ============================================

/**
 * One-time migration to convert cookingLog arrays on recipes
 * to events subcollection documents.
 *
 * Call this function manually to migrate existing data.
 */
export const migrateCookingLogs = onCall(async (request) => {
  // Only allow authenticated users
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting cooking log migration for user ${userId}`);

  // Get all boxes the user owns
  const boxesSnapshot = await db.collection("boxes")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalRecipes = 0;

  for (const boxDoc of boxesSnapshot.docs) {
    const boxId = boxDoc.id;

    // Get all recipes in this box
    const recipesSnapshot = await db.collection("boxes").doc(boxId)
      .collection("recipes").get();

    for (const recipeDoc of recipesSnapshot.docs) {
      const recipeId = recipeDoc.id;
      const recipeData = recipeDoc.data();
      const cookingLog = recipeData.cookingLog as Array<{
        madeAt: Timestamp;
        madeBy: string;
        note?: string;
      }> | undefined;

      if (!cookingLog || cookingLog.length === 0) {
        continue;
      }

      totalRecipes++;

      // Create events for each cooking log entry
      const eventsRef = db.collection("boxes").doc(boxId).collection("events");
      const batch = db.batch();

      for (const entry of cookingLog) {
        const eventRef = eventsRef.doc();
        batch.set(eventRef, {
          subjectId: recipeId,
          timestamp: entry.madeAt,
          createdAt: entry.madeAt, // Use same time since we don't have original createdAt
          createdBy: entry.madeBy,
          data: entry.note ? { notes: entry.note } : {},
        });
        totalMigrated++;
      }

      // Remove cookingLog from recipe after migration
      batch.update(recipeDoc.ref, {
        cookingLog: FieldValue.delete(),
      });

      await batch.commit();
      console.log(`Migrated ${cookingLog.length} entries from recipe ${recipeId}`);
    }
  }

  console.log(`Migration complete: ${totalMigrated} entries from ${totalRecipes} recipes`);
  return {
    success: true,
    recipesProcessed: totalRecipes,
    entriesMigrated: totalMigrated,
  };
})

// ============================================
// Migration: Life entries to events subcollection
// ============================================

/**
 * One-time migration to convert entries subcollection
 * to unified events format.
 *
 * Changes:
 * - Rename widgetId to subjectId
 * - Move notes and source into data
 *
 * Call this function manually to migrate existing data.
 */
export const migrateLifeEntries = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting life entries migration for user ${userId}`);

  // Get all life logs the user owns
  const logsSnapshot = await db.collection("lifeLogs")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalLogs = 0;

  for (const logDoc of logsSnapshot.docs) {
    const logId = logDoc.id;

    // Get all entries in this log
    const entriesSnapshot = await db.collection("lifeLogs").doc(logId)
      .collection("entries").get();

    if (entriesSnapshot.empty) {
      continue;
    }

    totalLogs++;
    const eventsRef = db.collection("lifeLogs").doc(logId).collection("events");

    // Process in batches of 500 (Firestore batch limit)
    const entries = entriesSnapshot.docs;
    const batchSize = 500;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = db.batch();
      const batchEntries = entries.slice(i, i + batchSize);

      for (const entryDoc of batchEntries) {
        const data = entryDoc.data();

        // Build unified event data - move notes and source into data field
        const eventData: Record<string, unknown> = { ...data.data };
        if (data.source) {
          eventData.source = data.source;
        }
        if (data.notes) {
          eventData.notes = data.notes;
        }

        // Create event with unified schema
        const eventRef = eventsRef.doc(entryDoc.id); // Keep same ID
        batch.set(eventRef, {
          subjectId: data.widgetId,
          timestamp: data.timestamp,
          createdAt: data.createdAt || data.timestamp,
          createdBy: data.createdBy,
          data: eventData,
        });

        // Delete old entry
        batch.delete(entryDoc.ref);
        totalMigrated++;
      }

      await batch.commit();
      console.log(`Migrated batch of ${batchEntries.length} entries from log ${logId}`);
    }
  }

  console.log(`Life entries migration complete: ${totalMigrated} entries from ${totalLogs} logs`);
  return {
    success: true,
    logsProcessed: totalLogs,
    entriesMigrated: totalMigrated,
  };
})

// ============================================
// Migration: Upkeep completions to events subcollection
// ============================================

/**
 * One-time migration to convert completions subcollection
 * to unified events format.
 *
 * Changes:
 * - Rename taskId to subjectId
 * - Rename completedBy to createdBy
 * - Rename completedAt to timestamp
 * - Move notes into data
 *
 * Call this function manually to migrate existing data.
 */
export const migrateUpkeepCompletions = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be authenticated");
  }

  const userId = request.auth.uid;
  console.log(`Starting upkeep completions migration for user ${userId}`);

  // Get all task lists the user owns
  const listsSnapshot = await db.collection("taskLists")
    .where("owners", "array-contains", userId)
    .get();

  let totalMigrated = 0;
  let totalLists = 0;

  for (const listDoc of listsSnapshot.docs) {
    const listId = listDoc.id;

    // Get all completions in this list
    const completionsSnapshot = await db.collection("taskLists").doc(listId)
      .collection("completions").get();

    if (completionsSnapshot.empty) {
      continue;
    }

    totalLists++;
    const eventsRef = db.collection("taskLists").doc(listId).collection("events");

    // Process in batches of 500 (Firestore batch limit)
    const completions = completionsSnapshot.docs;
    const batchSize = 500;

    for (let i = 0; i < completions.length; i += batchSize) {
      const batch = db.batch();
      const batchCompletions = completions.slice(i, i + batchSize);

      for (const compDoc of batchCompletions) {
        const data = compDoc.data();

        // Create event with unified schema
        const eventRef = eventsRef.doc(compDoc.id); // Keep same ID
        batch.set(eventRef, {
          subjectId: data.taskId,
          timestamp: data.completedAt,
          createdAt: data.completedAt, // Use completion time as createdAt
          createdBy: data.completedBy,
          data: data.notes ? { notes: data.notes } : {},
        });

        // Delete old completion
        batch.delete(compDoc.ref);
        totalMigrated++;
      }

      await batch.commit();
      console.log(`Migrated batch of ${batchCompletions.length} completions from list ${listId}`);
    }
  }

  console.log(`Upkeep completions migration complete: ${totalMigrated} completions from ${totalLists} lists`);
  return {
    success: true,
    listsProcessed: totalLists,
    completionsMigrated: totalMigrated,
  };
})

