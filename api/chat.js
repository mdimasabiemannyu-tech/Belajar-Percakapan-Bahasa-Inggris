
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY belum dipasang di Vercel."
    });
  }

  try {
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

    if (message.length > 4000) {
      return res.status(400).json({
        error: "Pesan terlalu panjang."
      });
    }

    const systemInstruction = `
You are Dimas English AI, a friendly English conversation tutor
for an Indonesian learner.

Student level: ${level}
Conversation topic: ${topic}

Your responsibilities:
1. Have a natural, open-ended English conversation.
2. Adapt your English to the student's level.
3. Avoid fixed or repetitive responses.
4. Ask one relevant follow-up question when appropriate.
5. Give a natural Indonesian translation of your reply.
6. Correct the student's English gently.
7. Explain corrections briefly in Indonesian.
8. Encourage the student.

Return ONLY valid JSON with exactly these keys:
{
  "reply_en": "Your natural English response",
  "translation_id": "Indonesian translation",
  "correction_id": "Correction and short Indonesian explanation, or empty string"
}

Do not use Markdown code fences.
`;

    // Fungsi untuk menghubungi Gemini
    async function callGemini(model) {
      const payload = {
        model,
        input: message,
        system_instruction: systemInstruction,
        generation_config: {
          thinking_level: "low"
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
          body: JSON.stringify(payload)
        }
      );

      const result = await response.json();

      return {
        response,
        result
      };
    }

    // Coba model utama terlebih dahulu
    let { response, result } = await callGemini(
      "gemini-3.8-flash"
    );

    // Jika model utama sibuk, gunakan model cadangan
    if (
      !response.ok &&
      (response.status === 429 || response.status === 503)
    ) {
      console.log(
        "Gemini 3.8 Flash sedang sibuk. Mencoba model cadangan..."
      );

      const fallback = await callGemini(
        "gemini-3.5-flash-lite"
      );

      response = fallback.response;
      result = fallback.result;
    }

    // Jika kedua model gagal
    if (!response.ok) {
      console.error("Gemini API error:", result);

      return res.status(response.status).json({
        error:
          result.error?.message ||
          "Gemini sedang mengalami gangguan. Silakan coba lagi."
      });
    }

    // Ambil teks jawaban
    const output =
      result.output_text ||
      (result.steps || [])
        .filter(step => step.type === "model_output")
        .flatMap(step => step.content || [])
        .filter(item => item.type === "text")
        .map(item => item.text)
        .join("\n");

    if (!output) {
      throw new Error("Gemini tidak memberikan jawaban.");
    }

    // Ubah jawaban menjadi JSON
    let answer;

    try {
      const cleanOutput = output
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      answer = JSON.parse(cleanOutput);

    } catch {
      answer = {
        reply_en: output,
        translation_id: "",
        correction_id: ""
      };
    }

    return res.status(200).json({
      id: result.id,
      reply_en: answer.reply_en || output,
      translation_id: answer.translation_id || "",
      correction_id: answer.correction_id || ""
    });

  } catch (error) {
    console.error("Server error:", error);

    return res.status(500).json({
      error:
        error.message ||
        "Terjadi kesalahan pada server."
    });
  }
}
