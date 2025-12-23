# Book Editor

A tool for writers to edit and refine their work with AI assistance.

## Development

```bash
cd app
npm install
npm run dev
```

## Deployment

```bash
firebase deploy --only hosting
```

Deploys to https://editor-5d5a3.web.app (and `editor.kirkl.in` once DNS is configured).

## Project Structure

```
├── app/                 # React frontend (Vite + TypeScript)
│   ├── src/
│   └── dist/           # Build output
├── firebase.json       # Firebase hosting config
└── .firebaserc         # Firebase project link
```

## Hosting

- **Firebase Project:** `recipe-box-335721` (shared with Recipe Box)
- **Hosting Site ID:** `editor-5d5a3`
- **Custom Domain:** `editor.kirkl.in` (pending DNS setup)

## API Access

This project shares a Firebase project with Recipe Box, so Cloud Functions have access to the `ANTHROPIC_API_KEY` secret. New functions for this app should be added to the shared functions directory or a new functions setup.
