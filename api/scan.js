const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; SEOScanner/1.0)" };

async function fetchWithTimeout(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: FETCH_HEADERS });
    clearTimeout(t);
    return r;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function extractPageData(url) {
  try {
    const parsed = new URL(url);
    const base   = parsed.origin;

    // Fetch main page first (measure response time), then robots + sitemap in parallel
    const t0      = Date.now();
    const mainRes = await fetchWithTimeout(url, 10000);
    const responseMs = Date.now() - t0;

    if (!mainRes || !mainRes.ok) return null;

    const [robotsRes, sitemapRes] = await Promise.all([
      fetchWithTimeout(base + "/robots.txt", 5000),
      fetchWithTimeout(base + "/sitemap.xml", 5000),
    ]);

    const html       = await mainRes.text();
    const finalUrl   = mainRes.url;
    const statusCode = mainRes.status;
    const pageKB     = Math.round(html.length / 1024);
    const xRobots    = mainRes.headers.get("x-robots-tag") || null;

    // --- helpers ---
    const get = (re) => {
      const m = html.match(re);
      return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
    };
    const getAll = (re) => {
      const out = [], g = new RegExp(re.source, "gi");
      let m;
      while ((m = g.exec(html)) !== null) out.push(m[1].replace(/<[^>]+>/g, "").trim());
      return out.filter(Boolean);
    };

    // --- on-page ---
    const title    = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc     = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})/i)
                  || get(/<meta[^>]+content=["']([^"']{0,400})["'][^>]+name=["']description["']/i);
    const canon    = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)
                  || get(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    const robotsMeta = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i);
    const viewport = get(/<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']+)/i);
    const lang     = get(/<html[^>]+lang=["']([^"']+)/i);

    const noindex  = (robotsMeta && /noindex/i.test(robotsMeta))
                  || (xRobots    && /noindex/i.test(xRobots));

    // --- headings ---
    const h1s = getAll(/<h1[^>]*>([\s\S]*?)<\/h1>/i).slice(0, 5);
    const h2s = getAll(/<h2[^>]*>([\s\S]*?)<\/h2>/i).slice(0, 8);
    const h3n = (html.match(/<h3[\s>]/gi) || []).length;

    // --- content ---
    const text = html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ").trim();
    const wordCount = text.split(" ").filter(w => w.length > 2).length;

    // --- images ---
    const totalImgs  = (html.match(/<img\b[^>]*>/gi) || []).length;
    const missingAlt = (html.match(/<img\b(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi) || []).length;

    // --- links ---
    const allHrefs = html.match(/href=["']([^"'#?]+)/gi) || [];
    const intLinks = allHrefs.filter(h =>
      /href=["']\//.test(h) || h.includes(parsed.hostname)
    ).length;
    const extLinks = allHrefs.filter(h =>
      /href=["']https?:\/\//.test(h) && !h.includes(parsed.hostname)
    ).length;

    // --- social & structured data ---
    const hasOG      = /<meta[^>]+property=["']og:/i.test(html);
    const hasTwitter = /<meta[^>]+name=["']twitter:/i.test(html);
    const schemaRaw  = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/gi)].map(m => m[1]);
    const schemas    = [...new Set(schemaRaw)].slice(0, 6);

    // --- robots.txt ---
    let robotsBlocking = false;
    if (robotsRes && robotsRes.ok) {
      const rtxt = await robotsRes.text();
      const starBlock = rtxt.match(/user-agent:\s*\*[\s\S]*?(?=user-agent:|$)/i)?.[0] || "";
      robotsBlocking = /disallow:\s*\/(\s|$)/i.test(starBlock);
    }

    // --- redirect ---
    const wasRedirected = mainRes.redirected && finalUrl !== url;

    return [
      `=== Technical ===`,
      `HTTP status: ${statusCode}`,
      `HTTPS: ${url.startsWith("https://") ? "yes" : "NO — page served over HTTP"}`,
      `Redirected: ${wasRedirected ? `yes → ${finalUrl}` : "no"}`,
      `Response time: ${responseMs}ms`,
      `Page size: ${pageKB}KB`,
      `Robots.txt blocking: ${robotsBlocking ? "YES ⚠" : "no"}`,
      `Sitemap (/sitemap.xml): ${sitemapRes?.ok ? "found" : "NOT FOUND"}`,
      ``,
      `=== On-Page ===`,
      `Title: ${title ? `"${title}" (${title.length} chars)` : "MISSING"}`,
      `Meta description: ${desc ? `"${desc.slice(0, 160)}" (${desc.length} chars)` : "MISSING"}`,
      `Canonical: ${canon || "MISSING"}${canon && canon !== url && canon !== finalUrl ? ` ← points away from this URL` : ""}`,
      `Robots meta: ${robotsMeta || "(not set)"}${noindex ? " ⚠ NOINDEX" : ""}`,
      `X-Robots-Tag: ${xRobots || "(not set)"}`,
      `Viewport meta: ${viewport || "MISSING — not mobile-optimised"}`,
      `HTML lang: ${lang || "MISSING"}`,
      ``,
      `=== Headings ===`,
      `H1 (${h1s.length}): ${h1s.join(" | ") || "NONE"}`,
      `H2 (${h2s.length}): ${h2s.slice(0, 5).join(" | ") || "none"}`,
      `H3 count: ${h3n}`,
      ``,
      `=== Content ===`,
      `Word count: ~${wordCount}`,
      ``,
      `=== Images ===`,
      `Total images: ${totalImgs}`,
      `Missing alt text: ${missingAlt} of ${totalImgs}`,
      ``,
      `=== Links ===`,
      `Internal links: ${intLinks}`,
      `External links: ${extLinks}`,
      ``,
      `=== Social & Structured Data ===`,
      `Open Graph: ${hasOG ? "present" : "MISSING"}`,
      `Twitter Card: ${hasTwitter ? "present" : "missing"}`,
      `Schema markup: ${schemas.length ? schemas.join(", ") : "NONE FOUND"}`,
    ].join("\n");
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  try {
    const { url, ...rest } = req.body;

    const pageData = url ? await extractPageData(url) : null;

    let claudeBody;
    if (pageData) {
      claudeBody = {
        model: rest.model,
        max_tokens: rest.max_tokens || 2000,
        system: rest.system,
        messages: [{ role: "user", content: `Audit: ${url}\n\nExtracted page data:\n${pageData}` }],
      };
    } else {
      // Fallback: web search if page can't be fetched (Cloudflare, auth, etc.)
      claudeBody = {
        ...rest,
        max_tokens: rest.max_tokens || 2000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
        messages: [{ role: "user", content: `Audit: ${url || ""}` }],
      };
    }

    const headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };

    const callApi = () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify(claudeBody),
    });

    let response = await callApi();

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get("retry-after") || "60", 10);
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 60) * 1000));
      response = await callApi();
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
