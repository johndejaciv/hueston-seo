// Pushes SEO audit tasks to Notion via Anthropic API + Notion MCP
// Uses hardcoded data source ID and user IDs confirmed from Hueston workspace

const NOTION_MCP = "https://mcp.notion.com/mcp";
const DATA_SOURCE_ID = "28110856-3466-810c-9e6e-000bc49d36d5";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const { title, due, assigneeName, body } = req.body;

  // Default assignee: John DeJac
  const assigneeId = "1edd872b-594c-818e-b5fe-000225734adb";

  // Build the exact create-pages call as a prompt
  const assigneeProp = assigneeId ? `"Assignee": "user://${assigneeId}",` : "";
  const prompt = `Use the notion-create-pages tool to create exactly one page with these exact values and nothing else:

Parent: data_source_id "${DATA_SOURCE_ID}"
Properties:
- "Task Name": "${title}"
- "date:Date:start": "${due}"
- "date:Date:is_datetime": 0
- "Status": "To Do"
- "Cadence": "Monthly"
${assigneeId ? `- "Assignee": "user://${assigneeId}"` : ""}

Content (use this markdown exactly):
${body}

Call notion-create-pages now with these values.`;

  try {
    // First call — Claude decides to use the tool
    const r1 = await fetch("https://api.anthropic.com/v1/messages", {
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
        mcp_servers: [{ type: "url", url: NOTION_MCP, name: "notion" }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const d1 = await r1.json();
    if (d1.error) throw new Error(d1.error.message);
    if (!r1.ok) throw new Error("API error: " + JSON.stringify(d1));

    // Check if Claude used the tool or returned an error
    const text = (d1.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const toolUse = (d1.content || []).find(b => b.type === "tool_use");
    const toolResult = (d1.content || []).find(b => b.type === "tool_result");

    // If stop_reason is tool_use, we need to continue the conversation
    if (d1.stop_reason === "tool_use" && toolUse) {
      // Second call — provide tool result back to Claude
      const r2 = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "mcp-client-2025-04-04",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          mcp_servers: [{ type: "url", url: NOTION_MCP, name: "notion" }],
          messages: [
            { role: "user", content: prompt },
            { role: "assistant", content: d1.content },
          ],
        }),
      });
      const d2 = await r2.json();
      if (d2.error) throw new Error(d2.error.message);
      return res.status(200).json({ ok: true, response: (d2.content || []).filter(b => b.type === "text").map(b => b.text).join("") });
    }

    // Check for error in response text
    if (text.toLowerCase().includes("error") || text.toLowerCase().includes("failed")) {
      throw new Error("Notion push failed: " + text.slice(0, 300));
    }

    return res.status(200).json({ ok: true, response: text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
