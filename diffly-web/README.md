# diffly-web

Browser UI for `diffly` seeded from DiffyData UX and wired to worker + WASM execution.

## Development

```bash
make web-install
make wasm-build-web
make web-dev
```

## Firebase Hosting (static client only)

This app can be deployed as a static export with no Next.js server runtime.

From repo root:

```bash
make wasm-build-web
npm --prefix diffly-web run build
firebase login
firebase use <your-firebase-project-id>
firebase deploy --only hosting
```

Notes:

- Static export output is generated at `diffly-web/out`.
- Firebase Hosting config is in `firebase.json` at repo root.
- `.firebaserc` is intentionally local/user-specific and should be created by `firebase use`.

## GitHub Actions Auto Deploy

Production deploy is automated in `.github/workflows/ci.yml`:

- Triggered on push to `main`, after all CI checks pass.
- Also supports manual run via `workflow_dispatch` (Actions tab), and deploys only when the selected ref is `main`.

Required repository secrets:

- `FIREBASE_PROJECT_ID`: your Firebase project id.
- `FIREBASE_TOKEN`: CI token from `firebase login:ci`.

## Large-file safety model

- Compare runs in a dedicated Web Worker (main thread remains interactive).
- Worker defaults to streaming parse path for larger files.
- Rust/WASM path is used for smaller files only (configurable threshold in UI).
- UI stores bounded sample events rather than full-row rendering for entire datasets.

This is intentionally optimized to avoid browser freezes during large comparisons (for example, two 100MB CSVs).
