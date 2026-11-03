const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://agustok.web.id");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return send(res, 405, { error: "Method not allowed" });
  }

  const expectedToken = process.env.VISION_API_TOKEN;
  if (!process.env.OPENAI_API_KEY || !expectedToken) {
    return send(res, 503, { error: "Vision service is not configured" });
  }

  const suppliedToken = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!suppliedToken || suppliedToken !== expectedToken) {
    return send(res, 401, { error: "Unauthorized" });
  }

  try {
    const { imageBase64, mimeType = "image/jpeg", prompt } = req.body || {};
    if (typeof imageBase64 !== "string" || !imageBase64) {
      return send(res, 400, { error: "imageBase64 is required" });
    }
    if (!ALLOWED_TYPES.has(mimeType)) {
      return send(res, 400, { error: "Unsupported image type" });
    }

    const cleanBase64 = imageBase64.replace(/^data:[^,]+,/, "");
    if (Math.floor(cleanBase64.length * 3 / 4) > MAX_IMAGE_BYTES) {
      return send(res, 413, { error: "Image exceeds the 4 MB limit" });
    }

    const userPrompt = typeof prompt === "string" && prompt.trim()
      ? prompt.trim().slice(0, 1000)
      : "Describe what the wearer is looking at. Focus on useful objects, visible text, and actions. Be concise and do not guess when details are unclear.";

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        max_output_tokens: 180,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: userPrompt },
            {
              type: "input_image",
              image_url: `data:${mimeType};base64,${cleanBase64}`,
              detail: "low"
            }
          ]
        }]
      })
    });

    const result = await upstream.json();
    if (!upstream.ok) {
      console.error("OpenAI Vision error:", upstream.status, result);
      return send(res, 502, { error: "Vision provider request failed" });
    }

    const description = (result.output || [])
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text)
      .join("\n")
      .trim();

    if (!description) {
      return send(res, 502, { error: "Vision provider returned no description" });
    }
    return send(res, 200, { description });
  } catch (error) {
    console.error("Vision endpoint error:", error);
    return send(res, 500, { error: "Internal server error" });
  }
};
