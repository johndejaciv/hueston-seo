async function extractPageData(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SEOScanner/1.0)" },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();

    const get = (re) => { const m = html.match(re); return m ? m[1].replace(/<[^>]+>/g, "").trim() : null; };
    const getAll = (re) => {
      const out = [], g = new RegExp(re.source, "gi");
      let m; while ((m = g.exec(html)) !== null) out.push(m[1].replace(/<[^>]+>/g, "").trim());
      return out.filter(Boolean);
    };

    const title   = get(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const desc    = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i)
                 || get(/<meta[^>]+content=["']([^"']{0,300})["'][^>]+name=["']description["']/i);
    const canon   = get(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)
                 || get(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
    const robots  = get(/<meta[^>]+name=["']robots["'][^>]+content=["']([^"']+)/i);
    const h1s     = getAll(/<h1[^>]*>([\s\S]*?)<\/h1>/i).slice(0, 3);
    const h2s     = getAll(/<h2[^>]*>([\s\S]*?)<\/h2>/i).slice(0, 5);
    const noAlt   = (html.match(/<img\b(?![^>]*\balt=["'][^"']+["'])[^>]*>/gi) || []).length;

    return [
      `Title: ${title ? `"${title}" (${title.length} chars)` : "(missing)"}`,
      `Meta description: ${desc ? `"${desc}" (${desc.length} chars)` : "(missing)"}`,
      `Canonical: ${canon || "(missing)"}`,
      `Robots meta: ${robots || "(not set — defaults to index, follow)"}`,
      `H1s (${h1s.length}): ${h1s.join(" | ") || "none"}`,
      `H2s (${h2s.length}): ${h2s.slice(0, 3).join(" | ") || "none"}`,
      `Structured data: ${/<script[^>]+application\/ld\+json/i.test(html) ? "present" : "missing"}`,
      `Open Graph tags: ${/<meta[^>]+property=["']og:/i.test(html) ? "present" : "missing"}`,
      `Images missing alt text: ${noAlt}`,
    ].join("\n");
  } catch {
    clearTimeout(timer);
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

    // Try to fetch and extract page data directly — avoids web search token cost entirely
    const pageData = url ? await extractPageData(url) : null;

    let claudeBody;
    if (pageData) {
      // Direct extraction succeeded — no tools needed (~300 input tokens total)
      claudeBody = {
        model: rest.model,
        max_tokens: rest.max_tokens || 1500,
        system: rest.system,
        messages: [{ role: "user", content: `Audit: ${url}\n\nExtracted page data:\n${pageData}` }],
      };
    } else {
      // Fallback: let Claude search (happens if site blocks fetching)
      claudeBody = {
        ...rest,
        max_tokens: rest.max_tokens || 1500,
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

    // Retry once on rate limit — wait for the retry-after window (capped at 60s)
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
