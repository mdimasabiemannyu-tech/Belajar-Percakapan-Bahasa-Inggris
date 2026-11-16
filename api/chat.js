
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY belum dipasang di Vercel."
    });
  }

  const {
    message,
    previousId,
    level = "Beginner",
    topic = "Daily Conversation"
  } = req.body || {};

  if (typeof message !== "string" || !message.trim()) {
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

You are a friendly, patient English conversation tutor
for Indonesian students.

STUDENT LEVEL: ${level}
CONVERSATION TOPIC: ${topic}

YOUR RULES:

1. Continue a natural, realistic conversation.
2. Use English appropriate to the student's level.
3. Remember the previous conversation.
4. Answer the actual message.
5. Ask only ONE relevant follow-up question.
6. Translate the student's original message into natural Indonesian.
7. Translate your English response into natural Indonesian.
8. Correct grammar mistakes gently.
9. Explain corrections briefly in Indonesian.
10. Keep answers short and conversational.
11. Never repeat generic responses.
12. Encourage the student.
13. If the student asks for help, answer helpfully.
14. Preserve the actual meaning of the student's message.

RESPONSE FIELDS:

reply_en:
Your English response to the student.

translation_user_id:
Natural Indonesian translation of the student's original message.

translation_id:
Natural Indonesian translation of your English response.

correction_id:
Brief grammar correction in Indonesian.
If there is no grammar mistake, return an empty string.

IMPORTANT:
Return all four fields in valid JSON.
Do not include Markdown or additional text.
`;

  const responseSchema = {
    type: "OBJECT",
    properties: {
      reply_en: {
        type: "STRING"
      },
      translation_user_id: {
        type: "STRING"
      },
      translation_id: {
        type: "STRING"
      },
      correction_id: {
        type: "STRING"
      }
    },
    required: [
      "reply_en",
      "translation_user_id",
      "translation_id",
      "correction_id"
    ],
    propertyOrdering: [
      "reply_en",
      "translation_user_id",
      "translation_id",
      "correction_id"
    ]
  };

  async function callGemini(model) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    try {
      const payload = {
        model,
        input: message,
        system_instruction: systemInstruction,

        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: responseSchema
        },

        generation_config: {
          thinking_level: "low",
          max_output_tokens: 350
        }
      };

      if (
        typeof previousId === "string" &&
        previousId.trim()
      ) {
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

      const raw = await response.text();

      let result;

      try {
        result = JSON.parse(raw);
      } catch {
        result = {
          error: {
            message: "Respons Gemini tidak valid."
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
    let response = null;
    let result = null;

    // MODEL UTAMA
    try {
      const primary = await callGemini(
        "gemini-3.1-flash-lite"
      );

      response = primary.response;
      result = primary.result;

    } catch (error) {
      console.error(
        "Primary model error:",
        error.message
      );
    }

    // MODEL CADANGAN
    const shouldRetry =
      !response ||
      [429, 500, 502, 503, 504].includes(
        response.status
      );

    if (shouldRetry) {
      console.log("Trying fallback model...");

      try {
        const fallback = await callGemini(
          "gemini-3.5-flash-lite"
        );

        response = fallback.response;
        result = fallback.result;

      } catch (error) {
        console.error(
          "Fallback model error:",
          error.message
        );

        return res.status(
          error.name === "AbortError" ? 504 : 502
        ).json({
          error:
            error.name === "AbortError"
              ? "Gemini terlalu lama merespons."
              : "Kedua model Gemini gagal dihubungi."
        });
      }
    }

    // CEK RESPONS GEMINI
    if (!response || !response.ok) {
      console.error("Gemini API Error:", result);

      return res.status(502).json({
        error:
          result?.error?.message ||
          "Gemini sedang mengalami gangguan."
      });
    }

    // AMBIL OUTPUT
    const output =
      result.output_text ||
      (result.steps || [])
        .filter(step => step.type === "model_output")
        .flatMap(step => step.content || [])
        .filter(item => item.type === "text")
        .map(item => item.text || "")
        .join("\n");

    if (!output) {
      throw new Error("Jawaban Gemini kosong.");
    }

    // PARSE JSON
    let answer;

    try {
      answer = JSON.parse(output.trim());
    } catch (error) {
      console.error("Invalid JSON:", output);

      throw new Error(
        "Format jawaban Gemini tidak valid."
      );
    }

    // VALIDASI EMPAT FIELD
    const requiredFields = [
      "reply_en",
      "translation_user_id",
      "translation_id",
      "correction_id"
    ];

    for (const field of requiredFields) {
      if (typeof answer[field] !== "string") {
        throw new Error(
          "Field Gemini tidak lengkap: " + field
        );
      }
    }

    // VALIDASI ID INTERAKSI
    if (!result.id) {
      throw new Error(
        "Gemini tidak mengirim ID percakapan."
      );
    }

    // KIRIM RESPONS KE INDEX.HTML
    return res.status(200).json({
      id: result.id,
      reply_en: answer.reply_en,
      translation_user_id: answer.translation_user_id,
      translation_id: answer.translation_id,
      correction_id: answer.correction_id
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
