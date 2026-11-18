# Frontend development

The mobile app uses Expo Router and connects to the backend through the shared
Socket.IO contracts in `@impostor/api`. The connection URL is read from
`EXPO_PUBLIC_API_URL`.

## Configure the backend URL

Copy `.env.example` to `.env.local` in this directory and set
`EXPO_PUBLIC_API_URL`. Restart Expo after changing the value.

Use the address that is reachable from the device running the app:

| Target | Example URL |
| --- | --- |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://127.0.0.1:3000` |
| Physical Android or iPhone | `http://<COMPUTER_LAN_IP>:3000` |

For a physical device, find the computer's local network IP (for example with
`ipconfig` on Windows), replace the placeholder, put both devices on the same
network, and allow inbound connections to port `3000` in the computer's
firewall. `localhost` and `127.0.0.1` on a phone refer to the phone itself, not
the development computer.

The backend defaults to port `3000`; if you change its `PORT`, use the same port
in `EXPO_PUBLIC_API_URL`. Native clients do not send a browser Origin header.
If testing through a web browser, configure the backend's `ALLOWED_ORIGINS` for
the Expo web origin.

HTTP is accepted by the frontend URL validator only for localhost and private
development networks. Use an `https://` URL for a public deployment; Socket.IO
will then negotiate a secure WebSocket (`wss://`) connection. In production,
TLS should terminate at the hosting provider or a reverse proxy in front of the
backend. Do not put credentials or API keys in the frontend URL or any
`EXPO_PUBLIC_` variable.

`EXPO_PUBLIC_` values are embedded in the client bundle and are public. Use this
variable only for the server URL, never for tokens, credentials, or API secrets.

## Run frontend and backend

Open two terminals at the monorepo root. Start the backend first:

```sh
npm run dev:backend
```

Then start Expo:

```sh
npm run dev:frontend
```

The root layout opens one reusable Socket.IO connection and keeps its status in
the Zustand connection store. The app reconnects automatically after temporary
network failures and restores room membership with the reconnect credentials
received from the backend, stored in Expo SecureStore.

## Development builds

Android local development build (requires Android Studio/SDK and a device or emulator):

```sh
npx expo run:android
```

Android EAS development build (requires an Expo account):

```sh
npx eas-cli build --platform android --profile development
```

iOS EAS development build (requires an Expo account and Apple Developer credentials):

```sh
npx eas-cli build --platform ios --profile development
```

EAS builds require project initialization and credentials:

```sh
npx eas-cli login
npx eas-cli init
npx eas-cli build:configure
```

For an EAS build, set `EXPO_PUBLIC_API_URL` in EAS Environment Variables or an
environment-specific EAS configuration before building. It must be the public
development backend URL reachable from the installed device.

Classic Impostor gameplay subscribes to the shared game events and renders
server-provided phases, deadlines, vote outcomes, winners, and final role
reveals. Role requests and votes use the existing Socket.IO client; the backend
remains authoritative for role assignment, vote validation, eliminations, and
win conditions.
