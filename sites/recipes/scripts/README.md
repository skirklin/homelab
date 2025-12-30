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

3. Set your Anthropic API key:
   ```bash
   export ANTHROPIC_API_KEY=your-key-here
   ```

## Scripts

### enrich-recipes.ts

Analyzes recipes with Claude and stores suggestions for later review in the UI.

```bash
# Dry run first (no changes written)
npm run enrich -- --dry-run

# Process just 2 recipes to test
npm run enrich -- --dry-run --limit 2

# Process only recipes owned by a specific user (by email)
npm run enrich -- --user you@example.com --limit 2 --dry-run

# Process only recipes in a specific box (partial name match)
npm run enrich -- --box "Family" --limit 2 --dry-run

# Combine filters
npm run enrich -- --user you@example.com --box "Favorites" --limit 2

# Run for real (only adds pendingEnrichment field, never modifies existing data)
npm run enrich
```

**Options:**
- `--dry-run` - Preview without writing any changes
- `--limit N` - Process only N recipes
- `--user <email|uid>` - Only process recipes owned by this user
- `--box <name>` - Only process recipes in boxes matching this name (case-insensitive partial match)
- `--emulator` - Connect to local Firebase emulator instead of production

**Safety features:**
- Only adds `pendingEnrichment` and `lastEnrichedAt` fields to recipes
- Never modifies existing recipe data (description, tags, etc.)
- Skips recipes that already have pending enrichments
- Skips recipes that haven't changed since last enrichment (safe to run daily)
- Re-processes recipes that users have edited since last enrichment

Users can then review and approve suggestions in the web UI.

### Testing with Emulator

You can test the enrichment workflow locally without affecting production data:

1. Start the Firebase emulators:
   ```bash
   firebase emulators:start
   ```

2. Seed test data (in another terminal):
   ```bash
   npm run seed
   ```
   This creates a test user (`test@example.com` / `testpassword123`) with sample recipes, some with pending enrichments.

3. Run the app pointing to emulators:
   ```bash
   cd ../app
   npm run dev
   ```

4. Log in and test the review UI.

To run the enrichment script against the emulator:
```bash
npm run enrich -- --emulator --dry-run
```

## Reviewing Suggestions in the UI

After running the enrichment script, suggestions appear in two places:

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
