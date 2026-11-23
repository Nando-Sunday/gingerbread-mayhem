# Gingerbread Mayhem V1.3.1

A desktop browser game built with Three.js, TypeScript, Vite, Rapier, and procedural Web Audio.

## Play online

**[Play Gingerbread Mayhem](https://nando-sunday.github.io/gingerbread-mayhem/)** in a desktop browser. Choose Gingerbread Gate on the Sugar Kingdom map, aim with the mouse, hold left click to fire, and press Escape to pause. Completing Level 1 unlocks Chocolate Citadel on that browser. Progress is stored locally for each player.

## Play locally

```bash
npm ci
npm run dev
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). Choose a level from **Sugar Kingdom**, move the mouse to aim, hold left click to fire, and press Escape to pause. If the browser cannot lock the pointer, aiming uses the mouse position instead. Gingerbread Gate is available immediately; completing it unlocks Chocolate Citadel. The victory screen offers **NEXT LEVEL** and the world map. Eight future levels remain visible and locked. The fixed port keeps browser saves on one local origin.

## Build and deploy

```bash
npm test
npm run build
npm run preview
```

The production site is in `dist/`. Upload that folder to any static HTTPS host. `netlify.toml` supplies the build and publish settings for a connected Netlify project. No server, account, or API key is needed at runtime.

## GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) runs tests, builds the site with the `/gingerbread-mayhem/` base path, and deploys `dist/` when `main` is pushed or the workflow is started manually. The repository must be named `gingerbread-mayhem` and Pages must use **GitHub Actions** as its source. No game data or account is sent to GitHub while playing; progress stays in each player's browser.

To check the Pages build locally:

```bash
npm run build:pages
npm run preview:pages
```

Open the URL printed by Vite with `/gingerbread-mayhem/` appended. The ordinary `npm run build` remains available for hosting at a domain root.

Progress is saved locally in the browser. V1.3.1 records completion explicitly, migrates earlier kingdom and V1.2 best-run saves, and keeps the older save in place. Browser storage is separate for each port and hostname.

The hidden development URL `/?qa=1` includes frame, physics, damage queue, body, projectile, particle, audio and renderer diagnostics. It provides completion and power-up checks for both castles, a save/unlock flow check, a dense collapse burst check, repeated level switches, and a three-minute firing stress run that alternates levels and weapon modes. Completion simulations target required structures through the gameplay raycast and damage path; they do not represent human playthroughs. QA save checks restore the user's progress afterward.
