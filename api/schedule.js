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

function getEndOfMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
}

function buildPrompt(url) {
  return "SEO audit of " + url + ". Search for: site:" + url + " and " + url + " sitemap robots pagespeed. Return ONLY JSON: {\"url\":\"" + url + "\",\"score\":<0-100>,\"summary\":\"<2 sentences>\",\"issues\":[{\"id\":\"<id>\",\"label\":\"<label>\",\"priority\":\"critical or medium\",\"category\":\"On-Page|Technical|Indexability|Performance|Content|Structured Data|Accessibility\",\"count\":<n>,\"affected\":[\"<url>\"],\"fix\":\"<fix>\"}],\"passed\":[\"<label>\"]}";
}

function buildBody(scan) {
  const crit = scan.issues.filter(i => i.priority === "critical");
  const med  = scan.issues.filter(i => i.priority === "medium");
  return [
    "## Summary", scan.summary || "", "",
    "SEO Score: " + scan.score + "/100", "",
    "## Critical Issues (" + crit.length + ")",
    ...crit.map(i => "- [ ] " + i.label + " — " + i.fix), "",
    "## Medium Issues (" + med.length + ")",
    ...med.map(i => "- [ ] " + i.label + " — " + i.fix), "",
    "## Next Steps",
    "- [ ] Review critical issues and assign to dev/content team",
    "- [ ] Schedule fixes before end of month",
    "- [ ] Re-scan after fixes to verify improvements",
  ].join("\n");
}

export default async function handler(req, res) {
  const sites = (await getJson("sites.json")) || [];

  if (sites.length === 0) {
    return res.status(200).json({ message: "No sites in database yet" });
  }

  const base = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000";
  const due = getEndOfMonth();
  const results = [];

  for (const url of sites) {
    try {
      // Step 1: Run SEO scan
      const scanRes = await fetch(base + "/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514",
          max_tokens: 4000,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: buildPrompt(url) }],
        }),
      });

      const scanData = await scanRes.json();
      if (!scanRes.ok) throw new Error("Scan API error: " + (scanData.error || JSON.stringify(scanData)));
      const text = (scanData.content || []).filter(b => b.type === "text").map(b => b.text).join("");
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) {
        results.push({ url, status: "no_json", detail: text.slice(0, 200) || "empty response" });
        continue;
      }

      let parsed;
      try { parsed = JSON.parse(match[0]); }
      catch (jsonErr) { results.push({ url, status: "invalid_json", detail: jsonErr.message }); continue; }
      const scan = { ...parsed, date: new Date().toISOString(), live: true };
      await putJson("scan-" + encodeURIComponent(url) + ".json", scan);

      await delay(5000);

      // Step 2: Push to Notion
      const title = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }) + " SEO Audit — " + url;
      const body = buildBody(scan);

      const pushRes = await fetch(base + "/api/notion-push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, due, body }),
      });

      const pushData = await pushRes.json();
      if (!pushRes.ok) throw new Error("Notion push failed: " + pushData.error);

      results.push({ url, status: "ok", score: scan.score, notion: "pushed" });
    } catch (e) {
      results.push({ url, status: "error", error: e.message });
    }

    await delay(8000);
  }

  return res.status(200).json({ scanned: results.length, results });
}
