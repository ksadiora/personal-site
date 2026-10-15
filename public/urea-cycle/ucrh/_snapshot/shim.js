// Read-only snapshot of the Urea Cycle Research Hub: answers the hub's own data requests from saved files,
// since there is no server behind karansadiora.com/urea-cycle/ucrh/. Loaded before the hub's scripts.
(() => {
  const P = '/urea-cycle/ucrh';
  const realFetch = window.fetch.bind(window);
  const lists = {};
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  function notice(text) {
    let el = document.querySelector('.ucrh-snapshot-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ucrh-snapshot-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), 4000);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    if (url.origin !== location.origin || !url.pathname.startsWith(P + '/') || url.pathname.startsWith(P + '/_')) {
      return realFetch(input, init);
    }
    const path = url.pathname.slice(P.length);
    if (method !== 'GET') {
      notice('This is a read-only snapshot, so likes, comments and saved keywords are off.');
      return json({ error: 'Read-only snapshot' }, 403);
    }
    const more = path.match(/^\/([A-Z0-9]+)\/load_more$/);
    if (more) {
      if (url.searchParams.get('extra')) {
        notice('Extra keywords run a live PubMed search, which the snapshot can’t do.');
        return json([]);
      }
      const gene = more[1];
      lists[gene] ||= realFetch(`${P}/_data/papers/${gene}.json`).then((r) => r.json());
      const all = await lists[gene];
      const offset = Number(url.searchParams.get('offset')) || 0;
      const limit = Number(url.searchParams.get('limit')) || 10;
      return json(all.slice(offset, offset + limit));
    }
    if (path.startsWith('/api/new-papers/')) return json({ papers: [] });
    if (/^\/api\/paper\/[^/]+\/comments$/.test(path) || path === '/api/combinations') return json([]);
    if (path.startsWith('/api/keywords/')) return json({ keywords: [] });
    return realFetch(input, init);
  };
})();
