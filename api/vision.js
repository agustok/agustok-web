const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const RETRY_DELAYS_MS = [1500, 3000];

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!geminiApiKey || !expectedToken) {
    return send(res, 503, { error: "Vision service is not configured" });
  }

  const suppliedToken = (req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "");

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

    const userPrompt =
      typeof prompt === "string" && prompt.trim()
        ? prompt.trim().slice(0, 1000)
        : "Describe what the wearer is looking at. Focus on useful objects, visible text, and actions. Be concise and do not guess when details are unclear.";

    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const requestOptions = {
      method: "POST",
      headers: {
        "x-goog-api-key": geminiApiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: userPrompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: cleanBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 180
        }
      })
    };

    let upstream;
    let result;

    // Retry only temporary Gemini capacity errors (HTTP 503).
    // Total attempts: 1 initial request + at most 2 retries.
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      upstream = await fetch(endpoint, requestOptions);

      if (upstream.status !== 503 || attempt === RETRY_DELAYS_MS.length) {
        break;
      }

      const delay = RETRY_DELAYS_MS[attempt];
      console.warn("Gemini Vision temporarily unavailable; retrying:", {
        status: upstream.status,
        retry: attempt + 1,
        delayMs: delay
      });

      await wait(delay);
    }

    result = await upstream.json();

    if (!upstream.ok) {
      const providerMessage =
        result?.error?.message || "Unknown Gemini provider error";

      console.error("Gemini Vision error:", {
        status: upstream.status,
        message: providerMessage
      });

      if (upstream.status === 503) {
        return send(res, 503, {
          error: "Gemini is temporarily busy. Please try again shortly."
        });
      }

      if (upstream.status === 429) {
        return send(res, 429, {
          error: "Gemini quota or rate limit exceeded"
        });
      }

      if (upstream.status === 400 || upstream.status === 401 || upstream.status === 403) {
        return send(res, 502, {
          error: "Gemini rejected the request. Check API key, model access, or request format."
        });
      }

      return send(res, 502, {
        error: "Gemini Vision provider request failed"
      });
    }

    const description = (result.candidates?.[0]?.content?.parts || [])
      .filter(part => typeof part.text === "string")
      .map(part => part.text)
      .join("\n")
      .trim();

    if (!description) {
      console.error("Gemini returned no description:", {
        finishReason: result.candidates?.[0]?.finishReason || "unknown"
      });

      return send(res, 502, {
        error: "Vision provider returned no description"
      });
    }

    return send(res, 200, { description });

  } catch (error) {
    console.error("Vision endpoint error:", error.message);

    return send(res, 500, {
      error: "Internal server error"
    });
  }
};
