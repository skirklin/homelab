# Recipe Box

A web app for storing and organizing your recipe collection. Import recipes from URLs or add them manually, then browse, search, and share with others.

Built with React, Firebase, and Firestore.

## Features

- **Recipe Import**: Import recipes from any URL with structured recipe data (schema.org/Recipe)
- **AI Recipe Generation**: Generate new recipes from a text description using Claude
- **Automatic Enrichment**: AI-powered descriptions and tags for imported recipes
- **Cooking Log**: Track when you make recipes with optional notes
- **Recipe Boxes**: Organize recipes into collections
- **Sharing**: Share recipes or entire boxes with other users
- **Search & Tags**: Full-text search and tag-based filtering
- **Wake Lock**: Keep screen on while cooking

## Architecture

### Frontend (`/app`)
- React with TypeScript
- Styled Components + Ant Design
- Firebase Auth for authentication
- Firestore for real-time data sync

### Cloud Functions (`/functions`)
- `getRecipes`: Fetches and parses recipe data from URLs
- `generateRecipe`: Generates recipes using Claude AI
- `addRecipeOwner` / `addBoxOwner`: Manages recipe/box sharing
- `enrichRecipes`: Scheduled function for automatic AI enrichment

## Automatic Recipe Enrichment

Recipes are automatically enriched with AI-generated descriptions and tags:

1. When a recipe is created/imported, it gets `enrichmentStatus: "needed"`
2. A scheduled Cloud Function runs every 10 minutes
3. It finds recipes with status "needed" that are at least 5 minutes old (delay allows user to finish editing)
4. Claude generates a description and suggested tags
5. These are saved as `pendingEnrichment` for user review
6. User can accept (applies changes) or reject (skips)
7. If user edits a recipe, status resets to "needed" for re-enrichment

### Enrichment Status Values
- `needed`: Awaiting AI processing
- `pending`: AI suggestions ready for user review
- `done`: User accepted enrichment
- `skipped`: User rejected, or recipe already had content

## Setup

### Prerequisites
- Node.js 20+
- Firebase CLI (`npm install -g firebase-tools`)
- Firebase project with Firestore, Auth, and Functions enabled

### Environment Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   cd app && npm install
   cd ../functions && npm install
   ```

3. Set up Firebase:
   ```bash
   firebase login
   firebase use <your-project-id>
   ```

4. Set the Anthropic API key for AI features:
   ```bash
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```

### Development

```bash
cd app
npm run dev
```

### Deployment

```bash
# Deploy everything
firebase deploy

# Deploy only hosting
firebase deploy --only hosting

# Deploy only functions
firebase deploy --only functions
```

## Monitoring

Set up Cloud Monitoring alerts for function errors:
1. Go to GCP Console → Monitoring → Alerting
2. Create a notification channel for your email
3. Create alert policy for `cloudfunctions.googleapis.com/function/execution_count` where `status = error`

## Project Structure

```
├── app/                    # React frontend
│   ├── src/
│   │   ├── Buttons/        # Action button components
│   │   ├── BoxTable/       # Box list view
│   │   ├── Header/         # Navigation header
│   │   ├── Modals/         # Modal dialogs
│   │   ├── RecipeCard/     # Recipe detail view
│   │   ├── RecipeTable/    # Recipe list view
│   │   ├── context.tsx     # React context for state
│   │   ├── reducer.ts      # State reducer
│   │   ├── firestore.ts    # Firestore operations
│   │   ├── storage.tsx     # Data models and converters
│   │   └── types.ts        # TypeScript types
│   └── build/              # Production build output
├── functions/              # Cloud Functions
│   └── src/
│       └── index.ts        # All function definitions
├── firestore.rules         # Security rules
├── firestore.indexes.json  # Firestore indexes
└── firebase.json           # Firebase configuration
```
