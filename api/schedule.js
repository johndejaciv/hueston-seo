import { put, list } from "@vercel/blob";

async function getSites() {
  try {
    const { blobs } = await list({ prefix: "sites.json" });
    if (!blobs.length) return [];
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return []; }
}

export default async function handler(req, res) {
  const sites = await getSites();

  if (sites.length === 0) {
    return res.status(200).json({ message: "No sites in database yet" });
  }

  const base = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000";
  const results = [];

  for (const url of sites) {
    try {
      const scanRes = await fetch(base + "/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1500,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: buildPrompt(url) }],
        }),
      });
      const data = await scanRes.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        const result = { ...JSON.parse(match[0]), date: new Date().toISOString(), live: true };
        const key = "scan-" + encodeURIComponent(url) + ".json";
        await put(key, JSON.stringify(result), { access: "public", addRandomSuffix: false });
        results.push({ url, status: "ok", score: result.score });
      } else {
        results.push({ url, status: "no_json" });
      }
    } catch (e) {
      results.push({ url, status: "error", error: e.message });
    }
  }

  return res.status(200).json({ scanned: results.length, results });
}

function buildPrompt(url) {
  return "You are an expert SEO auditor. Audit this site: " + url + ". Check title tags, meta descriptions, H1/H2, canonicals, noindex, sitemap, robots.txt, page speed, images, internal links, schema, mobile viewport, HTTPS, Core Web Vitals, thin content, alt text, Open Graph. Respond ONLY with valid JSON, no markdown: {\"url\":\"" + url + "\",\"score\":<0-100>,\"summary\":\"<2-3 sentences>\",\"issues\":[{\"id\":\"<id>\",\"label\":\"<label>\",\"priority\":\"critical or medium\",\"category\":\"On-Page|Technical|Indexability|Performance|Content|Structured Data|Accessibility\",\"count\":<n>,\"affected\":[\"<url>\"],\"fix\":\"<fix>\"}],\"passed\":[\"<label>\"]}";
}
