# Claude Context for Book Editor

## Project Overview

This is a book editing tool to help writers edit and refine their work with AI assistance. The project is in its early stages - just scaffolding has been set up.

## Tech Stack

- **Frontend:** React + TypeScript (Vite)
- **Hosting:** Firebase Hosting
- **API:** Anthropic Claude API (via Firebase Cloud Functions)
- **Styling:** Currently vanilla CSS, open to adding styled-components, Tailwind, or Ant Design

## Project Structure

```
book-editor/
├── app/                    # React frontend
│   ├── src/
│   │   ├── App.tsx         # Main app component (placeholder)
│   │   ├── App.css
│   │   └── main.tsx
│   ├── dist/               # Build output (gitignored)
│   └── package.json
├── firebase.json           # Hosting config
├── .firebaserc             # Links to Firebase project
└── README.md
```

## Deployment

```bash
# From project root
firebase deploy --only hosting
```

- **Firebase Project:** `recipe-box-335721` (shared with Recipe Box app)
- **Hosting Site ID:** `editor-5d5a3`
- **Live URL:** https://editor-5d5a3.web.app
- **Custom Domain:** `editor.kirkl.in` (DNS setup pending)

## Anthropic API Access

This project shares a Firebase project with Recipe Box. The `ANTHROPIC_API_KEY` is already configured as a Firebase secret.

**To call the Anthropic API:**

Option 1: Add new Cloud Functions to the shared functions directory at `/home/skirklin/projects/recipes/functions/`

Option 2: Create a `functions/` directory in this project and configure firebase.json for multi-project functions (more complex)

**Recommended:** Option 1 for simplicity. See `/home/skirklin/projects/recipes/functions/src/index.ts` for examples of how the Recipe Box project calls Anthropic (look at `generateRecipe` function).

Example function pattern:
```typescript
import Anthropic from '@anthropic-ai/sdk';
import { defineSecret } from "firebase-functions/params";

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

export const myFunction = onCall(
  { secrets: [anthropicApiKey] },
  async (request) => {
    const anthropic = new Anthropic({ apiKey: anthropicApiKey.value() });
    // ... make API calls
  }
);
```

## Related Files

- **Domain setup plan:** `/home/skirklin/projects/kirkl.in-plan.md`
- **Recipe Box project:** `/home/skirklin/projects/recipes` (shares Firebase project)
- **Recipe Box functions:** `/home/skirklin/projects/recipes/functions/src/index.ts`

## What Needs to Be Built

The user wants a tool to help with book editing. No detailed requirements have been discussed yet. You should:

1. Ask the user what features they want (structure editing, grammar, continuity tracking, AI suggestions, etc.)
2. Discuss target users (personal tool vs product for others)
3. Plan the architecture before building

## Development

```bash
cd app
npm install
npm run dev    # Starts dev server at localhost:5173
npm run build  # Builds to dist/
```

## Notes

- The project uses the same Firebase project as Recipe Box to share the Anthropic API key
- Firebase hosting sites are separate (different deploys, different domains)
- Cloud Functions are currently in the Recipe Box repo - new functions for this project should probably go there too for simplicity
