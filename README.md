# Grong

A browser-based music sketchpad with a multitouch piano roll, ADSR envelope, finger-driven pitch bends, optional scale snapping, drum machine, microphone-guided note capture, quantization, looping, and a multitrack timeline. Audio is processed in the browser; there is no server or account.

Drag A, P, D, or E onto the track canvas to insert a track. The piano and drum editors open in a Paneforge pane below the tracks. Drag the divider or use − and + to resize it. **Float** lets you drag the editor over the canvas; **Dock** returns it to the split layout. The playback bar stays at the bottom.

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

On mobile, install Grong from the browser's **Add to Home Screen** or **Install app** action and launch it from the home screen for a standalone view without browser navigation bars. A regular browser tab still shows the browser's own controls. The app also suppresses touch callouts and overscroll gestures on its controls while keeping its track and synth panels scrollable.

For more reliable vocal guidance, select **Calibrate voice** in the piano roll or drum machine. Stay quiet for the first second, then hum a clear note or beatbox several hits when prompted. Calibration is kept separately for each instrument while the page is open; use **Recalibrate voice** if the microphone or room changes.
