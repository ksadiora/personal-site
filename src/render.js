// The home page's text, as an HTML string. No DOM here, so it runs in two places:
// at build time (vite.config.js bakes it into index.html, so crawlers and link previews see the text)
// and in the browser (main.js renders it again, which keeps `npm run dev` current after edits).
import { person, hello, currently, previously, also, inputs } from './content.js';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// [text](url) becomes a link that opens in a new tab; everything else is escaped.
const md = (s) => esc(s).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) =>
  `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);

export function renderCard() {
  let d = 0;
  // Each block fades in a beat after the one above it.
  const rv = (cls = '') => `class="rv ${cls}" style="--d:${(d++ * 0.07).toFixed(2)}s"`;
  return `
  <div class="card" id="card">
    <h1 ${rv()}>${esc(hello)}</h1>
    ${currently.map((p) => `<p ${rv()}>${md(p)}</p>`).join('')}
    <p ${rv('sub')}>previously, i've:</p>
    <ul class="did">
      ${previously.map((p, i) => `
        <li ${rv()} data-i="${i}">
          <i class="mk" aria-hidden="true" style="--c:${inputs[i].color};--cl:${inputs[i].light}">*</i>
          <span>${md(p)}</span>
        </li>`).join('')}
    </ul>
    ${also.map((p) => `<p ${rv()}>${md(p)}</p>`).join('')}
    <nav ${rv('links')} aria-label="Links">
      ${[
        `<a href="mailto:${esc(person.email)}">email</a>`,
        `<a href="${esc(person.github)}" target="_blank" rel="noopener">github</a>`,
        `<a href="${esc(person.linkedin)}" target="_blank" rel="noopener">linkedin</a>`,
        person.resumePdf && `<a href="${esc(person.resumePdf)}" target="_blank" rel="noopener">resume</a>`,
      ].filter(Boolean).join('<span aria-hidden="true">·</span>')}
    </nav>
  </div>
`;
}

// schema.org Person, for search engines. Only facts that are already on the page.
export function personSchema() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: person.name,
    alternateName: 'Karanveer Sadiora',
    url: 'https://karansadiora.com/',
    email: `mailto:${person.email}`,
    affiliation: { '@type': 'CollegeOrUniversity', name: 'University of Virginia', url: 'https://www.virginia.edu/' },
    sameAs: [person.github, person.linkedin],
  }).replace(/</g, '\\u003c');
}
