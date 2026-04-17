const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; SEOScanner/1.0)" };
const MAX_PAGES = 150; // hard cap; caller passes desired limit via req.body.maxPages

const norm = u => { try { const p = new URL(u); return p.origin + p.pathname.replace(/\/$/, "") || p.origin; } catch { return u; } };

async function fetchDoc(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: FETCH_HEADERS });
    clearTimeout(t);
    return res;
  } catch {
    clearTimeout(t);
    return null;
  }
}

async function getSitemapUrls(base) {
  const res = await fetchDoc(base + "/sitemap.xml", 8000);
  if (!res || !res.ok) return [];
  const xml = await res.text();

  // Sitemap index — contains links to other sitemaps
  if (/<sitemapindex/i.test(xml)) {
    const subUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
    const allUrls = [];
    for (const sub of subUrls.slice(0, 3)) {
      const subRes = await fetchDoc(sub, 5000);
      if (subRes?.ok) {
        const subXml = await subRes.text();
        const urls = [...subXml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
        allUrls.push(...urls);
      }
      if (allUrls.length >= MAX_PAGES * 2) break;
    }
    return allUrls;
  }

  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
}

async function extractPage(url) {
  const t0  = Date.now();
  const res = await fetchDoc(url, 8000);
  const ms  = Date.now() - t0;

  if (!res) return { url, status: 0, ms, internalLinks: [] };
  const status = res.status;
  if (!res.ok)  return { url, status, ms, internalLinks: [] };

  const html = await res.text();

  const get = (re) => { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, "").trim() : null; };
  const getAll = (re) => {
    const out = [], g = new RegExp(re.source, "gi");
    let m; while ((m = g.exec(html)) !== null) out.push(m[1].replace(/<[^>]+>/g, "").trim());
    return out.filter(Boolean);
  };

  const title       = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc        = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,400})/i)
                   || get(/<meta[^>]+content=["']([^"']{0,400})["'][^>]+name=["']description["']/i);
  const canon       = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)
                   || get(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const robotsMeta  = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i)
                   || get(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']robots["']/i)
                   || get(/<meta[^>]+name=["']googlebot["'][^>]+content=["']([^"']+)/i)
                   || get(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']googlebot["']/i);
  const xRobots     = res.headers.get("x-robots-tag");
  const h1s         = getAll(/<h1[^>]*>([\s\S]*?)<\/h1>/i).slice(0, 3);
  const noindex     = /noindex/i.test(robotsMeta || "") || /noindex/i.test(xRobots || "");
  const missingAlt  = (html.match(/<img\b(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi) || []).length;
  const wordCount   = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ").trim()
    .split(" ").filter(w => w.length > 2).length;

  // Extract unique internal links (strip query/hash, cap at 50)
  const origin = new URL(url).origin;
  const internalLinks = [...new Set(
    [...html.matchAll(/href=["']([^"'#][^"']*)/gi)]
      .map(m => { try { const u = new URL(m[1], url); return u.origin === origin ? u.origin + u.pathname : null; } catch { return null; } })
      .filter(Boolean)
  )].slice(0, 50);

  return { url, status, ms, title, desc, canon, robotsMeta, h1s, noindex, wordCount, missingAlt, internalLinks };
}

function buildSummary(siteUrl, pages, brokenLinks = [], orphaned = []) {
  const ok     = pages.filter(p => p.status >= 200 && p.status < 300);
  const errors = pages.filter(p => p.status >= 400 || p.status === 0);

  // Aggregate counts
  const missingTitle = ok.filter(p => !p.title);
  const missingDesc  = ok.filter(p => !p.desc);
  const missingH1    = ok.filter(p => !p.h1s?.length);
  const multiH1      = ok.filter(p => (p.h1s?.length || 0) > 1);
  const noindexPages = ok.filter(p => p.noindex);
  const thin         = ok.filter(p => p.wordCount > 0 && p.wordCount < 300);
  const slow         = ok.filter(p => p.ms > 2000);
  const missingCanon = ok.filter(p => !p.canon);
  const totalAltMiss = ok.reduce((s, p) => s + (p.missingAlt || 0), 0);
  const avgMs        = ok.length ? Math.round(ok.reduce((s, p) => s + p.ms, 0) / ok.length) : 0;
  const avgWords     = ok.length ? Math.round(ok.reduce((s, p) => s + (p.wordCount || 0), 0) / ok.length) : 0;

  // Duplicate detection
  const titleCount = {};
  ok.forEach(p => { if (p.title) titleCount[p.title] = (titleCount[p.title] || []).concat(p.url); });
  const dupTitles = Object.entries(titleCount).filter(([, v]) => v.length > 1);

  const descCount = {};
  ok.forEach(p => { if (p.desc) descCount[p.desc] = (descCount[p.desc] || []).concat(p.url); });
  const dupDescs = Object.entries(descCount).filter(([, v]) => v.length > 1);

  const urls = (arr) => arr.map(p => p.url).join(", ");

  const lines = [
    `Site: ${siteUrl}`,
    `Pages crawled: ${pages.length} | 2xx: ${ok.length} | Errors: ${errors.length}`,
    ``,
    `=== Issues Found ===`,
  ];

  const longTitle   = ok.filter(p => p.title && p.title.length > 60);
  const shortTitle  = ok.filter(p => p.title && p.title.length < 30);
  const longDesc    = ok.filter(p => p.desc && p.desc.length > 160);

  if (missingTitle.length)  lines.push(`Missing title: ${missingTitle.length} pages → ${urls(missingTitle)}`);
  if (longTitle.length)     lines.push(`Title too long (>${60} chars): ${longTitle.length} pages → ${longTitle.map(p => `${p.url} (${p.title.length}c)`).join(", ")}`);
  if (shortTitle.length)    lines.push(`Title too short (<30 chars): ${shortTitle.length} pages → ${shortTitle.map(p => `${p.url} (${p.title.length}c)`).join(", ")}`);
  if (missingDesc.length)   lines.push(`Missing meta description: ${missingDesc.length} pages → ${urls(missingDesc)}`);
  if (longDesc.length)      lines.push(`Meta description too long (>160 chars): ${longDesc.length} pages → ${longDesc.map(p => `${p.url} (${p.desc.length}c)`).join(", ")}`);
  if (dupTitles.length)     lines.push(`Duplicate titles: ${dupTitles.length} groups (e.g. "${dupTitles[0][0].slice(0, 50)}" on ${dupTitles[0][1].length} pages: ${dupTitles[0][1].join(", ")})`);
  if (dupDescs.length)      lines.push(`Duplicate meta descriptions: ${dupDescs.length} groups (e.g. on ${dupDescs[0][1].join(", ")})`);
  if (missingH1.length)     lines.push(`Missing H1: ${missingH1.length} pages → ${urls(missingH1)}`);
  if (multiH1.length)       lines.push(`Multiple H1s: ${multiH1.length} pages → ${urls(multiH1)}`);
  if (noindexPages.length)  lines.push(`Noindex directive detected: ${noindexPages.length} pages → ${urls(noindexPages)}`);
  if (thin.length)          lines.push(`Thin content (<300 words): ${thin.length} pages → ${thin.map(p => `${p.url} (${p.wordCount}w)`).join(", ")}`);
  if (slow.length)          lines.push(`Slow response (>2s): ${slow.length} pages → ${slow.map(p => `${p.url} (${p.ms}ms)`).join(", ")}`);
  if (errors.length)        lines.push(`Error pages: ${errors.length} → ${errors.map(p => `${p.url} (${p.status || "failed"})`).join(", ")}`);
  if (missingCanon.length)  lines.push(`Missing canonical: ${missingCanon.length} pages → ${urls(missingCanon)}`);
  if (totalAltMiss)         lines.push(`Images missing alt text: ${totalAltMiss} total across site, affected pages: ${urls(ok.filter(p => p.missingAlt > 0))}`);
  if (brokenLinks.length)   lines.push(`Broken internal links (4xx/failed): ${brokenLinks.length} → ${brokenLinks.map(l => `${l.url} (HTTP ${l.status || "err"})`).join(", ")}`);
  if (orphaned.length)      lines.push(`Orphaned pages (no internal links pointing to them): ${orphaned.length} → ${orphaned.map(p => p.url).join(", ")}`);

  lines.push(``, `=== Site Averages ===`);
  lines.push(`Avg response time: ${avgMs}ms | Avg word count: ${avgWords}`);

  lines.push(``, `=== All Pages (${pages.length}) ===`);
  pages.forEach(p => {
    const flags = [];
    if (!p.title)                         flags.push("NO TITLE");
    else if (p.title.length > 60)         flags.push(`title ${p.title.length}c`);
    else if (p.title.length < 30)         flags.push(`title short (${p.title.length}c)`);
    if (!p.desc)                          flags.push("NO DESC");
    else if (p.desc.length > 160)         flags.push(`desc ${p.desc.length}c`);
    if (!p.h1s?.length)                   flags.push("NO H1");
    if ((p.h1s?.length || 0) > 1)        flags.push(`${p.h1s.length} H1s`);
    if (p.noindex)                        flags.push("NOINDEX");
    if (p.wordCount > 0 && p.wordCount < 300) flags.push(`thin(${p.wordCount}w)`);
    if (p.status >= 400 || p.status === 0) flags.push(`HTTP ${p.status || "err"}`);
    if (p.ms > 2000)                      flags.push(`slow(${p.ms}ms)`);
    const t = p.title ? `"${p.title.slice(0, 50)}"` : "(no title)";
    lines.push(`${p.url} — ${t}${flags.length ? " ⚠ " + flags.join(", ") : ""}`);
  });

  return lines.join("\n");
}

const SYSTEM_PROMPT = `You are a senior SEO analyst. Analyze the provided site crawl data and return ONLY valid JSON — no markdown, no extra text.
Schema: {"url":"<site-url>","score":<0-100>,"summary":"<2-3 sentences>","issues":[{"id":"<slug>","label":"<label>","priority":"critical|medium","category":"On-Page|Technical|Indexability|Performance|Content|Structured Data|Accessibility","count":<n>,"affected":["<url1>","<url2>",...],"fix":"<specific actionable fix>"}],"passed":["<label>"]}
Rules:
- The affected array MUST include ALL URLs where the issue occurs — never truncate or sample.
- count must equal affected.length (number of pages, not number of element instances).
- Flag ALL pages with a noindex directive as a critical Indexability issue, even if they appear intentional.
- Flag title too long/short and meta description too long as On-Page issues whenever present in the data.
- Flag thin content pages (<300 words) as a medium Content issue whenever present in the data.
- Prioritise issues affecting many pages. Score: start 100, deduct 10-15 per critical, 3-5 per medium.
- Only flag issues present in the data. No markdown — ONLY the JSON object.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { url, model, maxPages: reqMax } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  const pageLimit = Math.min(Math.max(parseInt(reqMax) || 50, 1), MAX_PAGES);

  try {
    const base = new URL(url).origin;

    // 1. Get URLs from sitemap
    const sitemapUrls = await getSitemapUrls(base);

    // 2. Build crawl list — root URL always first, then sitemap URLs up to pageLimit
    const toCrawl = sitemapUrls.length > 0
      ? [url, ...sitemapUrls.filter(u => u !== url)].slice(0, pageLimit)
      : [url];

    // 3. Crawl pages in batches of 5
    const pages = [];
    for (let i = 0; i < toCrawl.length; i += 5) {
      const batch = toCrawl.slice(i, i + 5);
      const results = await Promise.all(batch.map(u => extractPage(u)));
      pages.push(...results);
    }

    // 4. HEAD-check internal links not covered by the crawl (broken link detection)
    const crawledSet = new Set(toCrawl.map(u => { try { const p = new URL(u); return p.origin + p.pathname; } catch { return u; } }));
    const allLinked = new Set();
    pages.forEach(p => (p.internalLinks || []).forEach(l => allLinked.add(l)));
    const toHeadCheck = [...allLinked].filter(u => !crawledSet.has(u)).slice(0, 50);

    const brokenLinks = [];
    for (let i = 0; i < toHeadCheck.length; i += 10) {
      const batch = toHeadCheck.slice(i, i + 10);
      const results = await Promise.all(batch.map(async u => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch(u, { method: "HEAD", signal: ctrl.signal, headers: FETCH_HEADERS, redirect: "follow" });
          clearTimeout(t);
          return r.status >= 400 ? { url: u, status: r.status } : null;
        } catch { return { url: u, status: 0 }; }
      }));
      brokenLinks.push(...results.filter(Boolean));
    }

    // 5. Orphaned page detection — crawled OK pages with no inlinks from other crawled pages
    const normRoot = norm(url);
    const linkedTo = new Set();
    pages.forEach(p => (p.internalLinks || []).forEach(l => linkedTo.add(norm(l))));
    const orphaned = pages.filter(p =>
      p.status >= 200 && p.status < 300 &&
      norm(p.url) !== normRoot &&
      !linkedTo.has(norm(p.url))
    );

    // 6. Build aggregate summary and call Claude once
    const summary = buildSummary(url, pages, brokenLinks, orphaned);

    const claudeBody = {
      model: model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Full site audit: ${url}\n\n${summary}` }],
    };

    const apiHeaders = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };

    const callClaude = () => fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: apiHeaders, body: JSON.stringify(claudeBody),
    });

    let claudeRes = await callClaude();
    if (claudeRes.status === 429) {
      const wait = parseInt(claudeRes.headers.get("retry-after") || "60", 10);
      await new Promise(r => setTimeout(r, Math.min(wait, 60) * 1000));
      claudeRes = await callClaude();
    }

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) return res.status(claudeRes.status).json(claudeData);

    const text  = (claudeData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: "No JSON in Claude response", raw: text.slice(0, 300) });

    let parsed;
    try { parsed = JSON.parse(match[0]); }
    catch (e) { return res.status(500).json({ error: "Invalid JSON from Claude", detail: e.message }); }

    // Deterministically inject noindex issue if Claude missed it
    const noindexPages = pages.filter(p => p.noindex && p.status >= 200 && p.status < 300);
    if (noindexPages.length && !(parsed.issues || []).find(i => /noindex/i.test(i.id + " " + i.label))) {
      parsed.issues = [{
        id: "noindex_directive",
        label: "Pages with noindex directive",
        priority: "critical",
        category: "Indexability",
        count: noindexPages.length,
        affected: noindexPages.map(p => p.url),
        fix: "Review each URL and remove the noindex directive (meta robots tag or X-Robots-Tag header) if the page should be indexed by Google.",
      }, ...(parsed.issues || [])];
    }

    // Deterministically inject 404/error issue if Claude missed it
    const errorPages = pages.filter(p => p.status >= 400 || p.status === 0);
    const allBroken = [...errorPages.map(p => ({ url: p.url, status: p.status })), ...brokenLinks];
    if (allBroken.length && !(parsed.issues || []).find(i => /404|broken|error.page/i.test(i.id + " " + i.label))) {
      parsed.issues = [...(parsed.issues || []), {
        id: "broken_404",
        label: "Broken pages / 404 errors",
        priority: "critical",
        category: "Technical",
        count: allBroken.length,
        affected: allBroken.map(l => l.url + " (HTTP " + (l.status || "err") + ")"),
        fix: "Set up 301 redirects from all broken URLs to the most relevant live page. Update or remove internal links pointing to these URLs.",
      }];
    }

    return res.status(200).json({ ...parsed, pagesAudited: pages.length, brokenLinksFound: brokenLinks.length, orphanedFound: orphaned.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
