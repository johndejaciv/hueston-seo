// Dedicated endpoint for pushing SEO audit tasks to Notion
// Handles: schema discovery, user lookup, and page creation in sequence

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { notionUrl, title, due, assigneeName, body } = req.body;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

  const callClaude = async (messages, withNotion = true) => {
    const payload = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages,
    };
    if (withNotion) {
      payload.mcp_servers = [{ type: "url", url: "https://mcp.notion.com/mcp", name: "notion" }];
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-beta": "mcp-client-2025-04-04" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    return data.content || [];
  };

  try {
    // Step 1: Fetch the schema to get data_source_id and property names
    const schemaBlocks = await callClaude([{
      role: "user",
      content: `Use notion-fetch on this URL: ${notionUrl}
      
If it's a PAGE, look for an inline database in its content and fetch that database too.
If it's a DATABASE, fetch it directly.

Return ONLY a JSON object with no markdown:
{
  "data_source_id": "<the collection:// ID without the collection:// prefix>",
  "title_prop": "<exact name of the title property>",
  "date_prop": "<exact name of the date property, type=date>",
  "assignee_prop": "<exact name of the people/person property, or null if none>"
}`
    }]);
    const schemaText = schemaBlocks.filter(b => b.type === "text").map(b => b.text).join("");
    const schemaMatch = schemaText.match(/\{[\s\S]*\}/);
    if (!schemaMatch) throw new Error("Could not read Notion schema");
    const schema = JSON.parse(schemaMatch[0]);

    // Step 2: Look up user ID if assignee name provided
    let assigneeId = null;
    if (assigneeName && schema.assignee_prop) {
      const userBlocks = await callClaude([{
        role: "user",
        content: `Use notion-search with query_type "user" to find a workspace member named "${assigneeName}". Return ONLY a JSON object: {"user_id": "<id without user:// prefix, just the UUID>"}`
      }]);
      const userText = userBlocks.filter(b => b.type === "text").map(b => b.text).join("");
      const userMatch = userText.match(/\{[\s\S]*\}/);
      if (userMatch) {
        const userData = JSON.parse(userMatch[0]);
        assigneeId = userData.user_id;
      }
    }

    // Step 3: Create the page with exact property names
    const properties = {
      [schema.title_prop]: title,
      [`date:${schema.date_prop}:start`]: due,
      [`date:${schema.date_prop}:is_datetime`]: 0,
    };
    if (assigneeId && schema.assignee_prop) {
      properties[schema.assignee_prop] = `user://${assigneeId}`;
    }

    const createBlocks = await callClaude([{
      role: "user",
      content: `Use notion-create-pages to create a page with:
- parent: data_source_id "${schema.data_source_id}"
- properties: ${JSON.stringify(properties)}
- content: the markdown below

${body}

Return "done" when complete.`
    }]);

    return res.status(200).json({ ok: true, schema, assigneeId });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
