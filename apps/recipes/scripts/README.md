# Recipe Scripts

CLI scripts for managing recipes.

## Setup

1. Install dependencies:
   ```bash
   cd scripts
   npm install
   ```

2. Set up Firebase credentials (choose one):

   **Option A: Service Account Key (recommended)**
   - Go to [Firebase Console](https://console.firebase.google.com/project/recipe-box-335721/settings/serviceaccounts/adminsdk)
   - Click "Generate new private key"
   - Save as `scripts/service-account-key.json`

   **Option B: Application Default Credentials**
   ```bash
   gcloud auth application-default login
   ```

## Scripts

### seed-emulator.ts

Seeds the Firebase emulator with a test user (`test@example.com` / `testpassword123`) and sample recipes, some with pending enrichments.

```bash
npm run seed
```

### lowercase-tags.ts

One-off migration script that lowercases all `recipeCategory` tags.

```bash
npm run lowercase-tags
```

## Reviewing Suggestions in the UI

Suggestions are produced by the `POST /fn/ai/enrich` endpoint (triggered from the
recipe card "AI Enrich" menu item or the batch review modal) — see
`services/api/src/routes/ai.ts`. They appear in two places:

1. **Individual recipes** - A purple "AI Suggestions Available" banner shows on recipe cards with pending suggestions. Click Accept to apply or Dismiss to ignore.

2. **Batch review** - When recipes have pending suggestions, a purple "AI (N)" button appears in the recipe table toolbar. Click it to review all suggestions at once with bulk accept/dismiss options.

Accepting a suggestion:
- Adds the suggested description (if the recipe didn't have one)
- Merges suggested tags with existing tags (no duplicates)
- Removes the pending suggestion

## Running Tests

```bash
npm test
```
