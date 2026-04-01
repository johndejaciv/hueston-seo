// This runs automatically on the 1st of every month at 9am UTC
// It triggers a scan for every site stored in your SITES env variable

export default async function handler(req, res) {
  const sites = (process.env.SITES || "").split(",").map(s => s.trim()).filter(Boolean);

  if (sites.length === 0) {
    return res.status(200).json({ message: "No sites configured in SITES env var" });
  }

  const results = [];

  for (const url of sites) {
    try {
      const response = await fetch(`${process.env.APP_URL}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: buildPrompt(url) }],
        }),
      });
      results.push({ url, status: "scanned" });
    } catch (e) {
      results.push({ url, status: "error", error: e.message });
    }
  }

  res.status(200).json({ triggered: results });
}

function buildPrompt(url) {
  return `Perform a technical SEO audit of ${url}. Check title tags, meta descriptions, H1 tags, canonical tags, noindex, sitemap, robots.txt, page speed, images, internal links, schema markup, mobile viewport, HTTPS, thin content, alt text, Open Graph. Return ONLY valid JSON: {"url":"${url}","score":<0-100>,"summary":"<2-3 sentences>","issues":[{"id":"<id>","label":"<label>","priority":"critical"|"medium","category":"<category>","count":<n>,"affected":["<url>"],"fix":"<fix>"}],"passed":["<label>"]}`;
}
