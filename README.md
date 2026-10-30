# Grong

A browser-based music sketchpad with a multitouch piano roll and ADSR envelope, drum machine, microphone-guided note capture, quantization, looping, and a multitrack timeline. Audio is processed in the browser; there is no server or account.

## Develop locally

Use Node.js 24 and npm:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. Run `npm run check`, `npm run lint`, and `npm run build` before publishing.

## Publish to GitHub Pages

This repository is configured for `https://plachenko.github.io/grong/`. The workflow in `.github/workflows/pages.yml` builds and deploys the site whenever `master` is pushed, and can also be run from the Actions tab.

1. In the GitHub repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
2. Push the repository to `master`. The **Publish GitHub Pages** workflow will upload the static `build/` directory and deploy it.
3. Open `https://plachenko.github.io/grong/` after the deployment succeeds.

To test the Pages build locally:

```sh
GITHUB_PAGES_BASE=/grong npm run build
```

`GITHUB_PAGES_BASE` is empty for local development. Set it to the repository path when publishing from a different project repository, or leave it empty for a custom domain or a `username.github.io` repository. The `static/.nojekyll` file protects SvelteKit's `_app` assets if the output is ever served through the Jekyll publishing path.

Microphone guidance requires a secure context. GitHub Pages serves the site over HTTPS.
