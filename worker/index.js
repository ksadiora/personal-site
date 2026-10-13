// karansadiora.com: the site's static files (dist/), plus one endpoint for EyeSpeak at /eyespeak/.
// EyeSpeak sends the letters someone typed with their eyes here, and Gemini repairs them into a
// sentence. The Gemini key is a Worker secret (GEMINI_API_KEY, set in the Cloudflare dashboard), so it
// never reaches the browser. Same job as server.mjs in the EyeSpeak repo; keep the prompt in sync.

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

function cleanSentence(text) {
  return String(text ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

async function repair(request, env) {
  if (request.method !== 'POST') return json(405, { error: 'Use POST.' });

  // Only EyeSpeak's own page calls this. The per-visitor rate limit is what actually protects the key.
  const origin = request.headers.get('Origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json(403, { error: 'Not allowed.' });
  if (env.EYESPEAK_LIMIT) {
    const { success } = await env.EYESPEAK_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json(429, { error: 'Too many sentences at once. Wait a minute and try again.' });
  }
  if (!env.GEMINI_API_KEY) return json(503, { error: 'Sentence repair is not set up on this site yet.' });

  const raw = await request.text();
  if (raw.length > 12_000) return json(413, { error: 'Request is too large.' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'Sentence repair is unavailable.' }); }
  const text = cleanSentence(body?.text);
  if (!text) return json(400, { error: 'Write something before speaking.' });

  const prompt = [
    'You repair text created by an assistive eye keyboard.',
    'The input may have no spaces, spelling errors, or omitted letters.',
    'Infer the most likely concise sentence while preserving the person\'s intended meaning.',
    'Do not add facts, requests, names, or information that is not supported by the input.',
    'If meaning is genuinely unclear, make only minimal spacing and capitalization fixes.',
    'Return only the corrected sentence as plain text, with no explanation, label, markdown, or quotation marks.',
    `Input: ${text}`,
  ].join('\n');
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
      }),
    },
  );
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return json(502, { error: 'Gemini could not repair this sentence.' });
  const repaired = cleanSentence(result.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join(''));
  if (!repaired) return json(502, { error: 'Gemini returned no usable sentence.' });
  return json(200, { text: repaired });
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === '/eyespeak/api/repair') return repair(request, env);
    return env.ASSETS.fetch(request);
  },
};
