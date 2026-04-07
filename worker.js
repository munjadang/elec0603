/**
 * 6.3 지선 뉴스 프록시 — Cloudflare Worker
 *
 * 엔드포인트:
 *   GET /rss?q=검색어          → 구글 뉴스 RSS (JSON 변환)
 *   GET /health                → 상태 확인
 *
 * 환경변수 (Workers > Settings > Variables):
 *   ALLOWED_ORIGIN   허용할 프런트 도메인 (예: https://yourname.github.io)
 *                    미설정 시 * (전체 허용)
 */

const CACHE_TTL = 60 * 10; // RSS 캐시 10분 (초 단위)

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 허용 origin
    const allowOrigin = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204, allowOrigin);
    }

    // 라우팅
    if (url.pathname === '/health') {
      return corsResponse(JSON.stringify({ ok: true, time: new Date().toISOString() }), 200, allowOrigin);
    }

    if (url.pathname === '/rss') {
      return handleRSS(request, url, env, ctx, allowOrigin);
    }

    return corsResponse(JSON.stringify({ error: 'Not found' }), 404, allowOrigin);
  }
};

/* ── RSS 핸들러 ── */
async function handleRSS(request, url, env, ctx, allowOrigin) {
  const q = url.searchParams.get('q');
  if (!q) {
    return corsResponse(JSON.stringify({ error: 'q 파라미터가 필요합니다' }), 400, allowOrigin);
  }

  const encodedQ = encodeURIComponent(q.replace(/\+/g, ' '));
  const rssUrl = `https://news.google.com/rss/search?q=${encodedQ}&hl=ko&gl=KR&ceid=KR:ko`;

  // Cloudflare Cache API 활용
  const cacheKey = new Request(rssUrl, request);
  const cache = caches.default;

  // 캐시 확인
  let cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) {
    const cached = await cachedResponse.json();
    return corsResponse(JSON.stringify({ ...cached, _cached: true }), 200, allowOrigin);
  }

  // 구글 뉴스 RSS 요청
  let googleRes;
  try {
    googleRes = await fetch(rssUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsProxy/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true }
    });
  } catch (e) {
    return corsResponse(JSON.stringify({ error: '구글 뉴스 요청 실패', detail: e.message }), 502, allowOrigin);
  }

  if (!googleRes.ok) {
    return corsResponse(
      JSON.stringify({ error: `구글 응답 오류: ${googleRes.status}` }),
      502, allowOrigin
    );
  }

  const xml = await googleRes.text();
  const items = parseRSS(xml);
  const result = {
    query: q,
    count: items.length,
    updated: new Date().toISOString(),
    items
  };

  // 캐시 저장 (백그라운드)
  const toCache = new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_TTL}`
    }
  });
  ctx.waitUntil(cache.put(cacheKey, toCache));

  return corsResponse(JSON.stringify(result), 200, allowOrigin);
}

/* ── RSS XML 파서 ── */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title   = extractTag(block, 'title');
    const link    = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const source  = extractTag(block, 'source');
    const desc    = extractTag(block, 'description');

    if (!title) continue;

    items.push({
      title:   cleanText(title),
      link:    link?.trim() || '',
      source:  cleanText(source),
      pubDate: pubDate?.trim() || '',
      pubDateMs: pubDate ? new Date(pubDate).getTime() : 0,
      desc:    cleanText(desc).slice(0, 200),
    });
  }

  // 최신순 정렬
  return items.sort((a, b) => b.pubDateMs - a.pubDateMs);
}

function extractTag(str, tag) {
  const m = str.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function cleanText(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/* ── CORS 응답 헬퍼 ── */
function corsResponse(body, status, allowOrigin) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }
  });
}
