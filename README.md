# Tindeq Isometric Trainer

A small web app that connects to a [Tindeq Progressor](https://tindeq.com) over
Web Bluetooth and runs a timed isometric hold:

1. Enter a target weight in kg.
2. Connect the Progressor and press **Start hold**.
3. When the applied force reaches the target, a 6-second countdown starts and an
   **in-range** cue plays.
4. If the force drops below the target, the timer resets and a **failed** cue
   plays.
5. If you hold for the full 6 seconds, a **succeeded** cue plays.

## Requirements

- A Chromium-based browser (Chrome, Edge, Brave). Web Bluetooth is **not**
  available in Firefox or Safari.
- A secure context: `localhost` (the dev server) or an `https://` origin.
- [Nix](https://nixos.org) with flakes enabled. [direnv](https://direnv.net) is
  optional but supported (`use flake` in `.envrc`).

## Running

```sh
nix develop        # or: direnv allow
npm install
npm run dev
```

Then open the printed `http://localhost:5173` URL in a Chromium browser and
click **Connect Progressor**.

## Build

```sh
npm run build      # type-checks and outputs static files to dist/
npm run preview
```

## Deploying to GitHub Pages

The app is a static site, and GitHub Pages serves it over HTTPS — which Web
Bluetooth requires. A workflow at `.github/workflows/deploy.yml` builds and
publishes automatically on every push to `main`/`master`.

First-time setup:

1. Push the repo to GitHub (a **public** repo is simplest; Pages on a private
   repo needs a paid plan).
2. Push once. The workflow self-enables Pages (via `actions/configure-pages`
   with `enablement: true`), builds, and deploys.
   - If your org disallows auto-enablement, enable it manually instead:
     **Settings → Pages → Build and deployment → Source: GitHub Actions**, then
     re-run the workflow (**Actions** tab → the failed run → **Re-run failed
     jobs**).

The app then lives at `https://<user>.github.io/<repo>/`. Every later push
redeploys.

Troubleshooting: check the **Actions** tab. A green **build** job with a failed
**deploy** job almost always means Pages isn't enabled yet (see step 2). Vite's
`base` is set to `./` so assets resolve correctly from the Pages subpath.

## Notes

- Sounds are synthesized with the Web Audio API, so there are no audio files to
  ship. The AudioContext is unlocked on your first click (browser autoplay
  policy).
- The BLE protocol (service/characteristic UUIDs, command opcodes, little-endian
  float32 weight + uint32 microsecond timestamp packets) lives in
  `src/tindeq.ts`.
