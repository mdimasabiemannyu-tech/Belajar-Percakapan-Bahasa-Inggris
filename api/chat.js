export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "API Key Gemini belum dipasang."
    });
  }

  const {
    message,
    previousId,
    level = "Beginner",
    topic = "Daily Conversation"
  } = req.body || {};

  if (!message || typeof message !== "string") {
    return res.status(400).json({
      error: "Pesan tidak boleh kosong."
    });
  }

  if (message.length > 2000) {
    return res.status(400).json({
      error: "Pesan terlalu panjang."
    });
  }

  const systemInstruction = `
You are Dimas English AI.

You are a friendly English tutor for Indonesian students.

Student level: ${level}
Topic: ${topic}

RULES:

1. Speak naturally like a real conversation partner.
2. Use simple English appropriate to the student's level.
3. Remember the previous conversation.
4. Answer the student's actual message.
5. Ask only ONE relevant follow-up question.
6. Translate your English response into Indonesian.
7. Correct the student's grammar when necessary.
8. Explain mistakes briefly in Indonesian.
9. Keep responses short and natural.
10. Never repeat the same generic response.

Return valid JSON:

{
  "reply_en": "English response",
  "translation_id": "Indonesian translation",
  "correction_id": "Grammar correction and explanation"
}

If the student's sentence is already correct,
return an empty correction_id.

Do not use Markdown.
`;

  async function callGemini(model) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 25000);

    try {
      const payload = {
        model: model,
        input: message,
        system_instruction: systemInstruction,

        generation_config: {
          thinking_level: "low",
          max_output_tokens: 220,
          temperature: 0.7
        }
      };

      if (previousId) {
        payload.previous_interaction_id = previousId;
      }

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },

          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      const result = await response.json();

      return {
        response,
        result
      };

    } finally {
      clearTimeout(timeout);
    }
  }

  try {

    let response;
    let result;

    // MODEL UTAMA
    try {
      const primary = await callGemini(
        "gemini-3.1-flash-lite"
      );

      response = primary.response;
      result = primary.result;

    } catch (error) {
      if (error.name === "AbortError") {
        return res.status(504).json({
          error: "Gemini terlalu lama merespons."
        });
      }

      throw error;
    }

    // MODEL CADANGAN
    if (
      !response.ok &&
      [429, 500, 502, 503, 504].includes(response.status)
    ) {

      const fallback = await callGemini(
        "gemini-3.5-flash-lite"
      );

      response = fallback.response;
      result = fallback.result;
    }

    if (!response.ok) {
      console.error("Gemini Error:", result);

      return res.status(502).json({
        error:
          result.error?.message ||
          "Gemini sedang mengalami gangguan."
      });
    }

    const output =
      result.output_text ||
      (result.steps || [])
        .filter(step => step.type === "model_output")
        .flatMap(step => step.content || [])
        .filter(item => item.type === "text")
        .map(item => item.text)
        .join("\n");

    if (!output) {
      throw new Error("Jawaban Gemini kosong.");
    }

    let answer;

    try {
      const clean = output
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      answer = JSON.parse(clean);

    } catch {
      throw new Error(
        "Format jawaban AI tidak valid."
      );
    }

    return res.status(200).json({

      id: result.id,

      reply_en:
        answer.reply_en || "",

      translation_id:
        answer.translation_id || "",

      correction_id:
        answer.correction_id || ""

    });

  } catch (error) {

    console.error("Server Error:", error);

    return res.status(500).json({
      error:
        error.message ||
        "Terjadi kesalahan pada server."
    });

  }
}
