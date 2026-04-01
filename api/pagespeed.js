export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { url, strategy = "mobile" } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });

  const apiKey = process.env.GOOGLE_PAGESPEED_KEY;
  if (!apiKey) return res.status(500).json({ error: "GOOGLE_PAGESPEED_KEY not set" });

  try {
    const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&strategy=${strategy}&key=${apiKey}&category=performance&category=seo&category=accessibility&category=best-practices`;
    const r = await fetch(endpoint);
    const data = await r.json();

    if (data.error) return res.status(500).json({ error: data.error.message });

    const cats = data.lighthouseResult?.categories || {};
    const audits = data.lighthouseResult?.audits || {};
    const fcp = audits["first-contentful-paint"];
    const lcp = audits["largest-contentful-paint"];
    const tbt = audits["total-blocking-time"];
    const cls = audits["cumulative-layout-shift"];
    const si  = audits["speed-index"];
    const ttfb = audits["server-response-time"];

    return res.status(200).json({
      url,
      strategy,
      scores: {
        performance:    Math.round((cats.performance?.score    || 0) * 100),
        seo:            Math.round((cats.seo?.score            || 0) * 100),
        accessibility:  Math.round((cats.accessibility?.score  || 0) * 100),
        bestPractices:  Math.round((cats["best-practices"]?.score || 0) * 100),
      },
      metrics: {
        fcp:  { value: fcp?.displayValue  || "—", score: fcp?.score  },
        lcp:  { value: lcp?.displayValue  || "—", score: lcp?.score  },
        tbt:  { value: tbt?.displayValue  || "—", score: tbt?.score  },
        cls:  { value: cls?.displayValue  || "—", score: cls?.score  },
        si:   { value: si?.displayValue   || "—", score: si?.score   },
        ttfb: { value: ttfb?.displayValue || "—", score: ttfb?.score },
      },
      opportunities: Object.values(audits)
        .filter(a => a.details?.type === "opportunity" && a.score !== null && a.score < 0.9)
        .map(a => ({ id: a.id, label: a.title, score: a.score, savings: a.displayValue || "" }))
        .sort((a,b) => a.score - b.score)
        .slice(0, 8),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
