const FETCH_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; SEOScanner/1.0)" };
const MAX_PAGES = 50;

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
  const robotsMeta  = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i);
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

function buildSummary(siteUrl, pages, brokenLinks = []) {
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

  const urls = (arr, n = 5) => arr.slice(0, n).map(p => p.url).join(", ");

  const lines = [
    `Site: ${siteUrl}`,
    `Pages crawled: ${pages.length} | 2xx: ${ok.length} | Errors: ${errors.length}`,
    ``,
    `=== Issues Found ===`,
  ];

  if (missingTitle.length)  lines.push(`Missing title: ${missingTitle.length} pages → ${urls(missingTitle)}`);
  if (missingDesc.length)   lines.push(`Missing meta description: ${missingDesc.length} pages → ${urls(missingDesc)}`);
  if (dupTitles.length)     lines.push(`Duplicate titles: ${dupTitles.length} groups (e.g. "${dupTitles[0][0].slice(0, 50)}" on ${dupTitles[0][1].length} pages: ${dupTitles[0][1].slice(0, 3).join(", ")})`);
  if (dupDescs.length)      lines.push(`Duplicate meta descriptions: ${dupDescs.length} groups (e.g. on ${dupDescs[0][1].slice(0, 3).join(", ")})`);
  if (missingH1.length)     lines.push(`Missing H1: ${missingH1.length} pages → ${urls(missingH1)}`);
  if (multiH1.length)       lines.push(`Multiple H1s: ${multiH1.length} pages → ${urls(multiH1)}`);
  if (noindexPages.length)  lines.push(`Noindex detected: ${noindexPages.length} pages → ${urls(noindexPages)}`);
  if (thin.length)          lines.push(`Thin content (<300 words): ${thin.length} pages → ${thin.slice(0, 5).map(p => `${p.url} (${p.wordCount}w)`).join(", ")}`);
  if (slow.length)          lines.push(`Slow response (>2s): ${slow.length} pages → ${slow.slice(0, 3).map(p => `${p.url} (${p.ms}ms)`).join(", ")}`);
  if (errors.length)        lines.push(`Error pages: ${errors.length} → ${errors.slice(0, 5).map(p => `${p.url} (${p.status || "failed"})`).join(", ")}`);
  if (missingCanon.length)  lines.push(`Missing canonical: ${missingCanon.length} pages`);
  if (totalAltMiss)         lines.push(`Images missing alt text: ${totalAltMiss} total across site`);
  if (brokenLinks.length)   lines.push(`Broken internal links (4xx/failed): ${brokenLinks.length} → ${brokenLinks.slice(0, 5).map(l => `${l.url} (HTTP ${l.status || "err"})`).join(", ")}`);

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
Schema: {"url":"<site-url>","score":<0-100>,"summary":"<2-3 sentences>","issues":[{"id":"<slug>","label":"<label>","priority":"critical|medium","category":"On-Page|Technical|Indexability|Performance|Content|Structured Data|Accessibility","count":<n pages affected>,"affected":["<url1>","<url2>"],"fix":"<specific actionable fix naming exact pages>"}],"passed":["<label>"]}
Prioritise issues affecting many pages. Score: start 100, deduct 10-15 per critical issue, 3-5 per medium. Only flag issues present in the data. No markdown — ONLY the JSON object.`;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { url, model } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  try {
    const base = new URL(url).origin;

    // 1. Get URLs from sitemap
    const sitemapUrls = await getSitemapUrls(base);

    // 2. Build crawl list — root URL always first, then sitemap URLs up to MAX_PAGES
    const toCrawl = sitemapUrls.length > 0
      ? [url, ...sitemapUrls.filter(u => u !== url)].slice(0, MAX_PAGES)
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

    // 5. Build aggregate summary and call Claude once
    const summary = buildSummary(url, pages, brokenLinks);

    const claudeBody = {
      model: model || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
      max_tokens: 2000,
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

    return res.status(200).json({ ...parsed, pagesAudited: pages.length, brokenLinksFound: brokenLinks.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
