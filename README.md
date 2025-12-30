# Firebase Monorepo

Shared Firebase project hosting multiple sites with common Firestore rules and cloud functions.

## Sites

| Site | Description | Deploy Target |
|------|-------------|---------------|
| [recipes](sites/recipes/) | Recipe collection and sharing app | `hosting:recipes` |
| [groceries](sites/groceries/) | Grocery list management | `hosting:groceries` |
| [critic](sites/critic/) | Manuscript analysis tool | `hosting:editor`, `hosting:critic-wiki` |
| [homepage](sites/homepage/) | Personal homepage | `hosting:homepage` |

## Project Structure

```
firebase/
├── sites/
│   ├── recipes/          # Recipe Box app
│   ├── groceries/        # Groceries app
│   ├── critic/           # Manuscript critic tool
│   └── homepage/         # Personal site
├── functions/            # Cloud Functions (shared, primarily for recipes)
├── firestore.rules       # Shared Firestore security rules
├── firestore.indexes.json
├── firebase.json         # Unified Firebase config
└── .firebaserc           # Project and hosting targets
```

## Setup

### Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`

### Initial Setup

```bash
firebase login
firebase use recipe-box-335721
```

### Install Dependencies

```bash
# Functions
cd functions && npm install

# Individual sites (as needed)
cd sites/recipes/app && npm install
cd sites/groceries/app && npm install
cd sites/critic/app && npm install
```

## Development

Each site has its own dev server. See individual site READMEs for details.

```bash
# Example: recipes
cd sites/recipes/app && npm run dev

# Example: groceries
cd sites/groceries/app && npm run dev

# Example: critic
cd sites/critic/app && npm run dev
```

### Emulators

Run Firebase emulators for local development:

```bash
firebase emulators:start
```

## Deployment

### Deploy Individual Sites

```bash
firebase deploy --only hosting:recipes
firebase deploy --only hosting:groceries
firebase deploy --only hosting:homepage
firebase deploy --only hosting:editor      # critic app
firebase deploy --only hosting:critic-wiki # critic static wiki
```

### Deploy Firestore Rules

```bash
firebase deploy --only firestore
```

### Deploy Functions

```bash
firebase deploy --only functions
```

### Deploy Everything

```bash
firebase deploy
```

## Hosting Targets

| Target | Firebase Site | URL |
|--------|---------------|-----|
| `recipes` | recipe-box-335721 | https://recipe-box-335721.web.app |
| `groceries` | groceries-kirkl | https://groceries-kirkl.web.app |
| `homepage` | scott-kirkl-in | https://scott-kirkl-in.web.app |
| `editor` | editor-5d5a3 | https://editor-5d5a3.web.app |
| `critic-wiki` | critic-wiki | https://critic-wiki.web.app |

## Firestore Rules

Shared rules in `firestore.rules` cover:

- **Recipe Box**: User documents, boxes, and recipes with owner-based permissions
- **Groceries**: Lists, items, history, and trips with authenticated user access

## Cloud Functions

Located in `functions/`, primarily serving the recipes app:

- `getRecipes`: Fetch and parse recipe data from URLs
- `generateRecipe`: Generate recipes using Claude AI
- `addRecipeOwner` / `addBoxOwner`: Manage sharing
- `enrichRecipes`: Scheduled AI enrichment of imported recipes

### Function Secrets

```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
```
