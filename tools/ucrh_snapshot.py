"""Build the read-only snapshot of the Urea Cycle Research Hub served at karansadiora.com/urea-cycle/ucrh/.

Run the hub locally first (github.com/BI-CTSICN/Urea_Cycle_App, on a copy of its database with the users, email,
comment and interaction tables emptied), then:

    python3 tools/ucrh_snapshot.py http://127.0.0.1:5055

It crawls every page (home, the eight gene pages, the variant index, tables and all variant pages), prefixes the
hub's absolute paths with /urea-cycle/ucrh, hides what needs a live server (accounts, comments, likes, keyword
searches, email), saves each gene's paper list so "show more" works, and writes the RIS/PMID exports.
Output: public/urea-cycle/ucrh/ plus the export headers in public/_headers.
"""
import json
import re
import shutil
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BASE = sys.argv[1].rstrip('/') if len(sys.argv) > 1 else 'http://127.0.0.1:5055'
PREFIX = '/urea-cycle/ucrh'
SITE = Path(__file__).resolve().parent.parent
OUT = SITE / 'public' / 'urea-cycle' / 'ucrh'
GENES = ['OTC', 'CPS1', 'NAGS', 'ASS', 'ARG1', 'ASL', 'ORNT1', 'CITRIN']
# Pages that need a live server; their links are removed from the snapshot.
LIVE_ONLY = ['custom', 'community', 'email-subscriptions', 'login', 'register', 'logout', 'account', 'admin']
ROOTS = ['static', 'api', 'variants', 'export', *LIVE_ONLY, *GENES]
TAKEN = date.today().strftime('%b %-d, %Y')


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=120) as r:
        return r.read(), r.headers


def prefix_paths(text):
    """'/OTC', `/api/..`, "/static/..", `/${gene}`, href="/" → the same under /urea-cycle/ucrh."""
    text = re.sub(r'(?<=[`\'"(])/(?=(?:' + '|'.join(ROOTS) + r')\b|\$\{)', PREFIX + '/', text)
    return re.sub(r'(href=["\'])/(["\'])', r'\1' + PREFIX + r'/\2', text)


BANNER = (
    '<div class="ucrh-snapshot-bar">Read-only snapshot of the Urea Cycle Research Hub, taken ' + TAKEN + '. '
    'Live PubMed search, accounts, comments and email digests are off. '
    '<a href="/urea-cycle/">Paper and poster</a> · <a href="/">karansadiora.com</a></div>'
)


def snapshot_html(html):
    html = prefix_paths(html)
    # Drop links to live-only pages (nav, header, inline prompts).
    for page in LIVE_ONLY:
        html = re.sub(r'<a [^>]*href="' + re.escape(PREFIX) + '/' + page + r'"[^>]*>.*?</a>', '', html, flags=re.S)
    head = (f'<link rel="stylesheet" href="{PREFIX}/_snapshot/snapshot.css">'
            f'<script src="{PREFIX}/_snapshot/shim.js"></script>')
    html = html.replace('<head>', '<head>' + head, 1)
    return re.sub(r'(<body[^>]*>)', r'\1' + BANNER, html, count=1)


def out_file(path):
    """'/' → index.html, '/OTC' → OTC.html, '/variants/OTC/R40H' → variants/OTC/R40H.html."""
    return OUT / 'index.html' if path == '/' else OUT / (path.strip('/') + '.html')


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    pages = ['/', *[f'/{g}' for g in GENES], '/variants']
    for g in GENES:
        pages.append(f'/variants/{g}')
        rows = json.loads(get(f'/api/variants/{g}')[0])
        pages += [f'/variants/{g}/{urllib.parse.quote(r["variant"])}' for r in rows]

    assets = set()
    for i, path in enumerate(pages):
        html = get(path)[0].decode('utf8')
        # Any quoted /static/ path: src/href, and data-* attributes like the Mol* viewer's structure file.
        assets.update(re.findall(r'["\'](/static/[^"\'?#\s]+)', html))
        f = out_file(urllib.parse.unquote(path))
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(snapshot_html(html), encoding='utf8')
        if i % 400 == 0:
            print(f'{i}/{len(pages)} pages')

    for a in sorted(assets):
        body = get(a)[0]
        if a.endswith(('.js', '.css', '.html')):
            body = prefix_paths(body.decode('utf8')).encode('utf8')
        f = OUT / a.lstrip('/')
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(body)

    # Each gene's full paper list (date order), sliced in the browser for "show more".
    (OUT / '_data' / 'papers').mkdir(parents=True)
    for g in GENES:
        body = get(f'/{g}/load_more?offset=0&limit=100000&sort=date&extra=')[0]
        (OUT / '_data' / 'papers' / f'{g}.json').write_bytes(body)

    # Exports keep their download names through public/_headers.
    headers = ['# RIS / PMID exports from the hub snapshot (tools/ucrh_snapshot.py).']
    for g in GENES:
        for kind in ('ris', 'pmid'):
            body, h = get(f'/export/{g}/{kind}?extra=')
            f = OUT / 'export' / g / kind
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(body)
            headers += [f'{PREFIX}/export/{g}/{kind}', f'  Content-Type: {h["Content-Type"]}',
                        f'  Content-Disposition: {h["Content-Disposition"]}']
    snap = OUT / '_snapshot'
    snap.mkdir()
    shutil.copy(Path(__file__).with_name('ucrh_shim.js'), snap / 'shim.js')
    shutil.copy(Path(__file__).with_name('ucrh_snapshot.css'), snap / 'snapshot.css')
    (SITE / 'public' / '_headers').write_text('\n'.join(headers) + '\n')

    files = [p for p in OUT.rglob('*') if p.is_file()]
    print(f'done: {len(pages)} pages, {len(assets)} assets, {len(files)} files, '
          f'{sum(p.stat().st_size for p in files) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
