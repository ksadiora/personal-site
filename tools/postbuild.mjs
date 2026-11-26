// Runs after `vite build` (see package.json). Works on dist/ only, so the copied sources
// (public/eyespeak from the EyeSpeak repo, public/urea-cycle/ucrh from the snapshot tool) stay untouched
// and a refresh of either keeps these tags.
//   1. EyeSpeak: title with Karan's name, description, canonical, Open Graph.
//   2. Hub snapshot: description and canonical on every page; gene pages get the hub's name in the title.
//   3. sitemap.xml with every public page.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://karansadiora.com';
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
// dist/a/index.html → /a/ ; dist/a/b.html → /a/b (Cloudflare serves both without .html)
const urlOf = (file) => {
  const rel = relative(DIST, file).split(sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
};
const titleOf = (html) => (html.match(/<title>([^<]*)<\/title>/) || [])[1]?.trim() ?? '';
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function addHead(html, file, tags) {
  if (!/<\/head>/i.test(html)) throw new Error(`postbuild: no </head> in ${file}`);
  return html.replace(/<\/head>/i, `${tags}\n</head>`);
}
const metaTags = ({ url, description, title }) => [
  `<meta name="description" content="${esc(description)}" />`,
  `<link rel="canonical" href="${SITE}${url}" />`,
  `<meta property="og:url" content="${SITE}${url}" />`,
  title && `<meta property="og:title" content="${esc(title)}" />`,
  `<meta property="og:description" content="${esc(description)}" />`,
].filter(Boolean).join('\n');

// ---------- 1. EyeSpeak
const eye = join(DIST, 'eyespeak', 'index.html');
if (existsSync(eye)) {
  let html = readFileSync(eye, 'utf8');
  const title = 'EyeSpeak · Karan Sadiora';
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = addHead(html, eye, metaTags({
    url: '/eyespeak/',
    title,
    description: 'EyeSpeak lets you type with only your eyes and a webcam, right in the browser. Built by Karan Sadiora.',
  }));
  writeFileSync(eye, html);
}

// ---------- 2. Hub snapshot
const HUB = join(DIST, 'urea-cycle', 'ucrh');
const hubFiles = existsSync(HUB) ? walk(HUB).filter((f) => f.endsWith('.html')) : [];
const genes = hubFiles.filter((f) => relative(HUB, f).split(sep).length === 3).length; // variants/GENE/X.html
const perGene = {};
for (const f of hubFiles) {
  const parts = relative(HUB, f).split(sep);
  if (parts.length === 3) perGene[parts[1]] = (perGene[parts[1]] || 0) + 1;
}
const nGenes = Object.keys(perGene).length;
const fmt = (n) => n.toLocaleString('en-US');
const BY = 'A read-only snapshot of the Urea Cycle Research Hub, built by Karan Sadiora at Children\'s National.';

for (const f of hubFiles) {
  let html = readFileSync(f, 'utf8');
  const parts = relative(HUB, f).split(sep);
  let title = unesc(titleOf(html));
  let description;
  if (parts.length === 1 && parts[0] === 'index.html') {
    description = `Literature and ${fmt(genes)} variants across ${nGenes} urea cycle disorder genes. ${BY}`;
  } else if (parts.length === 1 && parts[0] === 'variants.html') {
    description = `Variant explorer: ${fmt(genes)} variants across ${nGenes} urea cycle disorder genes. ${BY}`;
  } else if (parts.length === 1) {
    // Gene page, e.g. "OTC - Ornithine Transcarbamylase"
    const [sym, ...rest] = title.split(' - ');
    const name = rest.join(' - ');
    description = `Research papers on ${sym}${name ? ` (${name})` : ''}, a urea cycle disorder gene. ${BY}`;
    title = `${title} — Urea Cycle Research Hub`;
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`);
  } else if (parts.length === 2) {
    const gene = parts[1].replace(/\.html$/, '');
    description = `All ${fmt(perGene[gene] || 0)} ${gene} variants in the Urea Cycle Research Hub. ${BY}`;
  } else {
    const gene = parts[1];
    const variant = parts[2].replace(/\.html$/, '');
    description = `${gene} ${variant}: variant details and 3D protein structure in the Urea Cycle Research Hub. ${BY}`;
  }
  html = addHead(html, f, metaTags({ url: urlOf(f), description, title }));
  writeFileSync(f, html);
}

// ---------- 3. sitemap.xml
const urls = ['/', '/urea-cycle/', existsSync(eye) && '/eyespeak/', ...hubFiles.map(urlOf).sort()].filter(Boolean);
writeFileSync(join(DIST, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map((u) => `  <url><loc>${SITE}${esc(u)}</loc></url>`).join('\n')
  + '\n</urlset>\n');

console.log(`postbuild: eyespeak meta ${existsSync(eye) ? 'ok' : 'skipped (no page)'}, ${hubFiles.length} hub pages tagged, sitemap ${urls.length} URLs`);
