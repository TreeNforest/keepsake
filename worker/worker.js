// 拾綴 Keepsake 預覽抓取 Worker
// 用法：GET /?url=<貼文網址>  → { url, author, text, image, isVideo }
//       GET /img?src=<圖片網址> → 轉送圖片（給 app 壓縮成縮圖）

const ALLOWED_ORIGINS = ['https://treenforest.github.io'];

const UAS = [
  'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response('forbidden', { status: 403 });
    const cors = { 'Access-Control-Allow-Origin': origin || '*', 'Vary': 'Origin' };
    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: { ...cors, 'Access-Control-Allow-Methods': 'GET' } });
    }

    const u = new URL(req.url);
    try {
      if (u.pathname === '/img') {
        if (!origin) return new Response('forbidden', { status: 403 });
        return await proxyImage(u.searchParams.get('src'), cors);
      }

      const target = u.searchParams.get('url');
      if (!target) return json({ error: 'missing url' }, 400, cors);

      const cache = caches.default;
      const key = new Request('https://cache.local/meta?u=' + encodeURIComponent(target));
      const hit = await cache.match(key);
      if (hit) return json(await hit.json(), 200, cors);

      const meta = await getMeta(target);
      if (meta.text || meta.image) {
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(meta), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
        })));
      }
      return json(meta, 200, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 502, cors);
    }
  },
};

async function getMeta(target) {
  const t = new URL(target);
  if (!/^https?:$/.test(t.protocol)) throw new Error('bad url');
  let fallback = null;
  for (const ua of UAS) {
    const r = await fetch(t.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': ua, 'Accept': 'text/html', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
    });
    const m = shape(await readMeta(r), r.url || t.toString());
    if (m.text || m.image) return m;
    fallback = fallback || m;
  }
  return fallback;
}

async function readMeta(res) {
  const tags = {};
  await new HTMLRewriter()
    .on('meta', {
      element(el) {
        const k = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        const v = el.getAttribute('content');
        if (k && v != null && !(k in tags)) tags[k] = v;
      },
    })
    .transform(res)
    .arrayBuffer();
  return tags;
}

function shape(t, finalUrl) {
  const g = k => decode(t[k] || '').trim();
  const host = new URL(finalUrl).hostname;
  const title = g('og:title') || g('twitter:title');
  let text = g('og:description') || g('twitter:description') || g('description');
  const image = g('og:image') || g('twitter:image');
  const isVideo = !!(t['og:video'] || t['og:video:url'] || t['og:video:secure_url']) || /video/.test(t['og:type'] || '');

  let author = '';
  const handle = title.match(/@([\w.]+)/);
  if (handle) author = '@' + handle[1];

  if (/instagram\.com$/.test(host)) {
    // og:description 常見格式：「123 likes, 4 comments - 帳號 on 日期: "內文"」
    const who = text.match(/-\s*([\w.]+)\s+(?:on|於)\s/);
    if (who && !author) author = '@' + who[1];
    const cap = text.match(/:\s*[“"]([\s\S]*)[”"]\s*\.?\s*$/);
    if (cap) text = cap[1].trim();
  }
  if (/facebook\.com$/.test(host) && !author) author = title.slice(0, 60);

  return { url: g('og:url') || finalUrl, author, text, image, isVideo };
}

async function proxyImage(src, cors) {
  const s = new URL(src || '');
  if (s.protocol !== 'https:') return new Response('bad src', { status: 400, headers: cors });
  const r = await fetch(s.toString(), { headers: { 'User-Agent': UAS[1] } });
  const type = r.headers.get('Content-Type') || '';
  if (!r.ok || !type.startsWith('image/')) return new Response('upstream error', { status: 502, headers: cors });
  return new Response(r.body, {
    headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' },
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    e = e.toLowerCase();
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}
