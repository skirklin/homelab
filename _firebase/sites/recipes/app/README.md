# Recipe Box

A web app for organizing and sharing recipes, built with React and Firebase.

## Prerequisites

- Node.js 20+ (use `nvm use 20`)
- Firebase CLI (`npm install -g firebase-tools` or use `npx firebase-tools`)

## Development

```bash
cd app
npm install
npm run dev
```

Opens at [http://localhost:5173](http://localhost:5173) with hot reload.

## Testing

```bash
cd app
npm test
```

Runs tests with Vitest in watch mode. Tests cover utilities, reducer logic, and storage classes.

## Building

```bash
cd app
npm run build
```

Builds to `app/build/` for production.

## Deployment

Deploy the frontend only (most common):

```bash
npx firebase-tools deploy --only hosting
```

Deploy everything (hosting, functions, firestore rules):

```bash
npx firebase-tools deploy
```

The hosting deploy automatically runs lint and build before uploading.

## Project Structure

- `app/` - React frontend (Vite + TypeScript)
- `functions/` - Firebase Cloud Functions
- `firebase.json` - Firebase configuration
- `firestore.rules` - Firestore security rules

## Data Schema

```
/boxes/{box_id}/
               /name = string
               /recipes/(recipe_id)/
                                   /recipe = (recipe data)
                                   /version = string
               /owners = [ref(user_id), ref(user_id)]
/user/{user_id}/
               /boxes = [ref(box_id), ref(box_id)]
               /new = bool
```
