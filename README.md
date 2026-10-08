# unred

Browser-based Japanese-to-Indonesian localization workbench for KAG and KiriKiri scripts.

## Run locally

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Build and check types with `pnpm build` and `pnpm typecheck`.

## Deploy to Vercel

Import this folder as the project root. The included `vercel.json` configures the Vite build, static output directory, and single-page-app routing. No backend or environment secrets are required. Imported scripts and translations stay in the user's browser.
