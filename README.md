# personal-site

Karan Sadiora's personal site: one clean page over a live neuron.

The text is a short intro, a "previously, i've:" list and links (email, github, linkedin, resume). Behind it,
a 3D neuron sits in a culture of monochrome cells and fires on its own every few seconds: inputs arrive on its
dendrites, sum at the cell body, and past threshold (−55 mV) it fires an action potential down the myelinated axon
to the synapse.

Each line under "previously" is wired to one dendrite, and its `*` marker carries that branch's color. Hovering a
line sends an input down its branch; hover a few in a row and the cell fires. Clicking the cell fires it outright.
The corner readout shows the membrane potential live.

The terminal synapses onto a small next neuron that brightens when vesicles release. Everything sways gently
(dendrites wander, a slow wave runs down the axon), from one motion field shared by every vertex shader (`SWAY`
in `src/neuron.js`), so attached parts never separate. On screens 1080px and wider the page fits one screen
without scrolling: `fit()` in `src/main.js` shrinks the text (all card spacing is in em) on short windows.

The sun/moon button switches between dark (fluorescence micrograph) and light (ink on a glass slide); the choice is
saved per browser. Below 1080px wide the cell sits in a band at the top and the text runs underneath.

**EyeSpeak runs on the site at `/eyespeak/`.** Its files are a copy of `../_archive/eyespeak/public/` in
`public/eyespeak/` (refresh with `npm run sync:eyespeak`, from github.com/ksadiora/eyespeak). Its sentence repair
calls `/eyespeak/api/repair`, which `worker/index.js` answers: it sends the typed letters to Gemini with the Worker
secret `GEMINI_API_KEY`, allows 20 requests a minute per visitor, and refuses other websites. Without the secret,
typing still works and Speak shows "not set up yet".

The earlier scroll-driven resume version is saved, runnable, in `../personal-site-scroll/`.

## Run

```bash
npm install
npm run dev        # http://localhost:5178 via the Personal Site .claude/launch.json, or Vite's default port
npm run build      # static output in dist/
```

## Edit content

Everything is in `src/content.js`. `[text](url)` becomes a link.

- `previously` has five lines because the cell has five colored dendrites (`inputs`, same order, top branch
  first). To add a sixth line, add a sixth input and a sixth angle in `src/neuron.js` (`angles`).
- The resume link appears only when `person.resumePdf` is set. To add it: export a public copy of the resume
  (no phone number, no street address), save it as `public/resume.pdf`, set `resumePdf: '/resume.pdf'`, commit.
  The private resume never goes in this repo; `.gitignore` blocks `public/Karan_Sadiora_Resume.pdf`.

## Files

| File | What it does |
|---|---|
| `src/content.js` | All copy and links |
| `src/main.js` | Renders the page; the cell's firing model (inputs, threshold, spike); camera framing; hover and click |
| `src/neuron.js` | Builds the cell and the culture around it; shaders |
| `src/stage.js` | Renderer, bloom, microscope pass (fringe, vignette, grain) |
| `src/util.js` | Math helpers |
| `worker/index.js` | Cloudflare Worker: serves `dist/`, and runs EyeSpeak's Gemini sentence repair |
| `wrangler.jsonc` | Worker config: name, assets, the `/eyespeak/api/*` route, the rate limit |
| `public/eyespeak/` | The EyeSpeak app, copied from its repo |

## Dev tricks

- `?theme=light` forces a theme. `?fire=3` holds off the automatic firing and fires the cell 3 s after load, for
  screenshots of the action potential. Both work on the dev server, or a build made with `VITE_SHOTS=1`.
- `window.__ks` in dev: `__ks.fire()` fires the cell, `__ks.stimulate(i)` sends one input down dendrite `i`.

## Deploy

Live domain: **karansadiora.com** (registered on Cloudflare). Repo: github.com/ksadiora/personal-site (private).

Hosted on Cloudflare as a Worker named `karansadiora` (Workers & Pages), connected to this repo with Workers
Builds, so every push to `main` builds and deploys:

- Build command `npm run build`; then `npx wrangler deploy` reads `wrangler.jsonc`: `dist/` as static assets, plus
  the Worker in `worker/index.js` for `/eyespeak/api/*` only. Node comes from `.node-version` (22).
- Secret: `GEMINI_API_KEY` (Worker → Settings → Variables and Secrets). Deploys keep it.
- Test the Worker locally with `npm run preview:worker` (http://localhost:8787). Put a test key in `.dev.vars`
  (gitignored) as `GEMINI_API_KEY=...`.
- Custom domains: `karansadiora.com` and `www.karansadiora.com`, added on the Worker (Settings → Domains & Routes).
  Because the DNS is on Cloudflare, it creates the records itself.

## Skill layer

Cloned from `../design-starter` (design/animation skills, impeccable hooks, Playwright MCP). Its README explains that
layer. That tooling (`.claude/`, `.cursor/`, `.mcp.json`) stays local and is not committed.
