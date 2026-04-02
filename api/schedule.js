import { put, list } from "@vercel/blob";

async function getJson(key) {
  try {
    const { blobs } = await list({ prefix: key });
    if (!blobs.length) return null;
    const res = await fetch(blobs[0].url);
    return await res.json();
  } catch { return null; }
}

async function putJson(key, data) {
  await put(key, JSON.stringify(data), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function extractDbId(input) {
  const m = input.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  return m ? m[1] : input.trim();
}

export default async function handler(req, res) {
  const sites = (await getJson("sites.json")) || [];
  const settings = (await getJson("settings.json")) || {};

  if (sites.length === 0) {
    return res.status(200).json({ message: "No sites in database yet" });
  }

  const base = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000";
  const results = [];

  for (const url of sites) {
    try {
      // Run SEO scan
      const scanRes = await fetch(base + "/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: buildPrompt(url) }],
        }),
      });
      const data = await scanRes.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.match(/\{[\s\S]*\}/);

      if (match) {
        const result = { ...JSON.parse(match[0]), date: new Date().toISOString(), live: true };
        await putJson("scan-" + encodeURIComponent(url) + ".json", result);

        // Auto-push to Notion if configured
        const siteSettings = settings[url] || {};
        if (siteSettings.notionLink) {
          const dbId = extractDbId(siteSettings.notionLink);
          const due = getEndOfMonth();
          const mention = siteSettings.notionUser ? " Find the Notion workspace member named '" + siteSettings.notionUser + "' and assign them to this page." : "";
          await fetch(base + "/api/scan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1000,
              mcp_servers: [{ type: "url", url: "https://mcp.notion.com/mcp", name: "notion" }],
              messages: [{
                role: "user",
                content: "Create a new page in Notion database ID: " + dbId + ". Set the due date property to " + due + "." + mention + " " + buildNotionPrompt(url, result) + " Use the create-pages tool now."
              }],
            }),
          });
          results.push({ url, status: "ok", score: result.score, notion: "pushed" });
        } else {
          results.push({ url, status: "ok", score: result.score, notion: "no link saved" });
        }
      } else {
        results.push({ url, status: "no_json" });
      }
    } catch (e) {
      results.push({ url, status: "error", error: e.message });
    }
    await delay(5000);
  }

  return res.status(200).json({ scanned: results.length, results });
}

function buildPrompt(url) {
  return "SEO audit of " + url + ". Search for: site:" + url + " and " + url + " sitemap robots pagespeed. Return ONLY JSON: {\"url\":\"" + url + "\",\"score\":<0-100>,\"summary\":\"<2 sentences>\",\"issues\":[{\"id\":\"<id>\",\"label\":\"<label>\",\"priority\":\"critical or medium\",\"category\":\"On-Page|Technical|Indexability|Performance|Content|Structured Data|Accessibility\",\"count\":<n>,\"affected\":[\"<url>\"],\"fix\":\"<fix>\"}],\"passed\":[\"<label>\"]}";
}

function getEndOfMonth() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return end.toISOString().split("T")[0];
}

function buildNotionPrompt(url, scan) {
  const crit = scan.issues.filter(i => i.priority === "critical");
  const med = scan.issues.filter(i => i.priority === "medium");
  const due = getEndOfMonth();
  return "Create a Notion SEO task. Respond ONLY with valid JSON: {\"title\":\"<site+month/year SEO Audit>\",\"priority\":\"High|Medium|Low\",\"due_date\":\"" + due + "\",\"body\":\"<markdown ## Critical Issues ## Medium Issues ## Next Steps with - [ ] checkboxes>\"}. Site=" + url + " Score=" + scan.score + "/100 Critical(" + crit.length + ")=" + crit.map(i => i.label + ": " + i.fix).join("; ") + " Medium(" + med.length + ")=" + med.map(i => i.label + ": " + i.fix).join("; ");
}
