import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vite';

const page = (p) => fileURLToPath(new URL(p, import.meta.url));
const HOME = page('index.html');

// Bakes the home page's text and Person schema into index.html, so the page isn't empty
// before JavaScript runs (crawlers, link previews). The 3D cell still draws on top in the browser.
// (In dev, main.js renders the text again in the browser, so content.js edits show up without a restart.)
const prerender = () => ({
  name: 'prerender-home',
  transformIndexHtml: {
    order: 'pre',
    async handler(html, ctx) {
      if (ctx.filename !== HOME) return html;
      const { renderCard, personSchema } = await import(`${pathToFileURL(page('src/render.js')).href}?t=${Date.now()}`);
      const main = '<main class="page" id="page"></main>';
      if (!html.includes(main)) throw new Error('prerender-home: <main id="page"> not found in index.html');
      return html
        .replace(main, `<main class="page" id="page">${renderCard()}</main>`)
        .replace('</head>', `    <script type="application/ld+json">${personSchema()}</script>\n  </head>`);
    },
  },
});

// Two pages: the home page, and /urea-cycle/ (the paper and poster).
// tools/postbuild.mjs then adds meta tags to EyeSpeak and the hub snapshot, and writes sitemap.xml.
export default defineConfig({
  plugins: [prerender()],
  build: {
    rollupOptions: {
      input: { main: HOME, ureaCycle: page('urea-cycle/index.html') },
    },
  },
});
