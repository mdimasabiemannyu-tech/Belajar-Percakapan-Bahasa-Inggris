
export default async function handler(req, res) {
  // Hanya menerima POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "API Key Gemini belum dipasang di Vercel."
    });
  }

  const {
    message,
    previousId,
    level = "Beginner",
    topic = "Daily Conversation"
  } = req.body || {};

  // Validasi pesan
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      error: "Pesan tidak boleh kosong."
    });
  }

  if (message.length > 2000) {
    return res.status(400).json({
      error: "Pesan terlalu panjang."
    });
  }

  // Instruksi AI
  const systemInstruction = `
You are Dimas English AI.

You are a friendly English conversation tutor
for Indonesian students.

Student level: ${level}
Conversation topic: ${topic}

RULES:

1. Speak naturally like a real conversation partner.
2. Use simple English appropriate to the student's level.
3. Remember the previous conversation.
4. Answer the student's actual message.
5. Ask only ONE relevant follow-up question.
6. Translate your English response into Indonesian.
7. Correct grammar mistakes gently.
8. Explain mistakes briefly in Indonesian.
9. Keep responses short and natural.
10. Never repeat generic responses.
11. Encourage the student to keep practicing.
12. Do not make the conversation sound like a textbook.

Return ONLY valid JSON with exactly these keys:

{
  "reply_en": "English response",
  "translation_id": "Indonesian translation",
  "correction_id": "Grammar correction and explanation"
}

If the student's sentence is already correct,
return an empty correction_id.

Do not use Markdown code fences.
`;

  // Fungsi untuk menghubungi Gemini
  async function callGemini(model) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 20000);

    try {
      const payload = {
        model: model,
        input: message,
        system_instruction: systemInstruction,

        generation_config: {
          thinking_level: "low",
          max_output_tokens: 220
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

      const responseText = await response.text();

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        result = {
          error: {
            message: "Respons Gemini bukan JSON yang valid."
          }
        };
      }

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
    let primaryError = null;

    // =================================
    // MODEL UTAMA
    // =================================

    try {
      const primary = await callGemini(
        "gemini-3.1-flash-lite"
      );

      response = primary.response;
      result = primary.result;

    } catch (error) {
      primaryError = error;

      console.error(
        "Primary Gemini Error:",
        error.message
      );
    }

    // =================================
    // CEK APAKAH PERLU MODEL CADANGAN
    // =================================

    const shouldUseFallback =
      !response ||
      !response.ok &&
      [429, 500, 502, 503, 504].includes(response.status);

    if (shouldUseFallback) {
      console.log("Using fallback Gemini model...");

      try {
        const fallback = await callGemini(
          "gemini-3.5-flash-lite"
        );

        response = fallback.response;
        result = fallback.result;

      } catch (fallbackError) {
        console.error(
          "Fallback Gemini Error:",
          fallbackError.message
        );

        if (fallbackError.name === "AbortError") {
          return res.status(504).json({
            error: "Model utama dan cadangan terlalu lama merespons."
          });
        }

        return res.status(502).json({
          error: "Model utama dan cadangan gagal dihubungi."
        });
      }
    }

    // =================================
    // CEK HASIL AKHIR API
    // =================================

    if (!response || !response.ok) {
      console.error("Gemini API Error:", result);

      return res.status(502).json({
        error:
          result?.error?.message ||
          "Gemini sedang mengalami gangguan."
      });
    }

    // =================================
    // AMBIL JAWABAN AI
    // =================================

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

    // =================================
    // PARSE JSON
    // =================================

    let answer;

    try {
      const cleanOutput = output
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      answer = JSON.parse(cleanOutput);

    } catch {
      console.error("Invalid AI Output:", output);

      throw new Error(
        "Format jawaban AI tidak valid. Silakan coba lagi."
      );
    }

    // =================================
    // KIRIM HASIL KE FRONTEND
    // =================================

    return res.status(200).json({
      id: result.id || null,

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
