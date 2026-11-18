# Impostor & Manhunt

Impostor & Manhunt is a real-time multiplayer party game for Android and iPhone. It is built as an npm-workspaces monorepo with a React Native and Expo mobile app, an authoritative Node.js game server, and a shared package of API contracts.

## Project structure

- `frontend/` contains the Expo Router mobile application.
- `backend/` contains the Node.js and Express server and will own game state and validation.
- `api/` contains shared event names, payload types, validation schemas, REST contracts, and constants. It must not contain game logic or UI.

The frontend and backend both depend on the workspace package `@impostor/api`; shared contracts should be defined there rather than duplicated.

## Install dependencies

From the repository root, install all workspace dependencies with npm:

```sh
npm install
```

## Run the projects

Start the Expo development server:

```sh
npm run dev:frontend
```

Start the backend development process:

```sh
npm run dev:backend
```

## Build and type-check

Build the shared API package:

```sh
npm run build:api
```

Run TypeScript checks for all three workspaces (the API package is built first so its declarations are available):

```sh
npm run typecheck
```

## npm workspaces

The root `package.json` declares `frontend`, `backend`, and `api` as npm workspaces. npm installs their dependencies from the repository root and links the local `@impostor/api` package into the frontend and backend. Workspace scripts can be run from the root using the scripts above.
