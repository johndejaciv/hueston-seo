// Pushes directly to Notion using Anthropic API + Notion MCP
// Data source ID and assignee hardcoded from confirmed Hueston workspace schema

const DATA_SOURCE_ID = "28110856-3466-810c-9e6e-000bc49d36d5";
const ASSIGNEE_ID    = "1edd872b-594c-818e-b5fe-000225734adb"; // John DeJac

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { title, due, body } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });

  // Convert body text to Notion markdown blocks
  const content = (body || "").split("\n").map(line => {
    if (line.startsWith("## ")) return "## " + line.replace(/^## /, "");
    if (line.startsWith("- [ ] ")) return "- [ ] " + line.replace(/^- \[ \] /, "");
    if (line.startsWith("- ")) return "- " + line.replace(/^- /, "");
    return line;
  }).join("\n");

  try {
    // Single focused call — just create the page, no discovery needed
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        mcp_servers: [{ type: "url", url: "https://mcp.notion.com/mcp", name: "notion" }],
        messages: [{
          role: "user",
          content: `Call notion-create-pages with exactly these parameters and nothing else:

parent: {"type": "data_source_id", "data_source_id": "${DATA_SOURCE_ID}"}
pages: [{
  "properties": {
    "Task Name": "${title.replace(/"/g, '\\"')}",
    "date:Date:start": "${due}",
    "date:Date:is_datetime": 0,
    "Status": "To Do",
    "Cadence": "Monthly",
    "Assignee": "user://${ASSIGNEE_ID}"
  },
  "content": ${JSON.stringify(content)}
}]

Call the tool now.`
        }],
      }),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    if (!response.ok) throw new Error("API error " + response.status + ": " + JSON.stringify(data));

    // Check response for success or error
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const toolResults = (data.content || []).filter(b => b.type === "mcp_tool_result");

    // If there are tool results, check them for errors
    for (const tr of toolResults) {
      const resultText = tr.content?.[0]?.text || "";
      if (resultText.includes("error") || resultText.includes("Error")) {
        throw new Error("Notion MCP error: " + resultText.slice(0, 200));
      }
    }

    return res.status(200).json({ ok: true, response: text.slice(0, 200) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
