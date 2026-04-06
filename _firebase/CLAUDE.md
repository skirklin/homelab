# Claude Context for Firebase Monorepo

## Overview

This is a Firebase monorepo containing multiple sites that share a single Firebase project (`recipe-box-335721`). Each site is independent but shares Firestore rules and cloud functions.

## Structure

```
firebase/
├── sites/
│   ├── home/             # React app - unified home with all apps embedded
│   ├── recipes/          # React app - recipe collection
│   ├── groceries/        # React app - grocery lists
│   ├── life/             # React app - life tracker (widgets, sampling)
│   ├── upkeep/           # React app - household task management
│   ├── shared/           # Shared React components and utilities
│   ├── critic/           # React + Python - manuscript analysis
│   └── homepage/         # Static personal site
├── functions/            # Cloud Functions (Node.js/TypeScript)
├── firestore.rules       # Shared security rules
├── firestore.indexes.json
├── SCHEMA.md             # Firestore data model documentation
└── firebase.json
```

## Site-Specific Context

Each site has its own CLAUDE.md with detailed context:
- `sites/critic/CLAUDE.md` - Manuscript analysis tool architecture

## Development Commands

```bash
# Deploy a specific site
firebase deploy --only hosting:recipes
firebase deploy --only hosting:groceries
firebase deploy --only hosting:editor
firebase deploy --only hosting:critic-wiki
firebase deploy --only hosting:homepage

# Deploy rules or functions
firebase deploy --only firestore
firebase deploy --only functions

# Run emulators
firebase emulators:start
```

## Key Files

- `firebase.json` - All hosting targets, functions config, emulator ports
- `.firebaserc` - Project ID and hosting target mappings
- `firestore.rules` - Security rules for all collections
- `firestore.indexes.json` - Composite indexes for queries
- `SCHEMA.md` - Firestore data model documentation
- `functions/src/index.ts` - Cloud function definitions

## Working in This Repo

- **Site changes**: Work within `sites/<name>/` directory
- **Function changes**: Work in `functions/`
- **Rule changes**: Edit `firestore.rules` at root
- **Paths in firebase.json**: All paths are relative to repo root (e.g., `sites/recipes/app/build`)

## Firebase Project

- **Project ID**: `recipe-box-335721`
- **Console**: https://console.firebase.google.com/project/recipe-box-335721
