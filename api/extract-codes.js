export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageBase64, mimeType } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: 'Image is required' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Vercel par GEMINI_API_KEY set nahi hai!' });
  }

  // Agar ek model busy ho toh agla try karega
  const models = ['gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
  const payload = {
    contents: [
      {
        parts: [
          {
            text: `Extract all IGNOU subject/course codes from this image (examples: BCOS183, BCOC-133, BEGAE182, BPAS-184, MPA-036). Return ONLY a JSON array of uppercase strings.`
          },
          {
            inline_data: {
              mime_type: mimeType || 'image/jpeg',
              data: imageBase64
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json'
    }
  };

  let lastError = 'AI server busy hai, 10 second baad dobara try karein.';

  for (const model of models) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      );

      const data = await response.json();

      if (!response.ok) {
        lastError = data?.error?.message || response.statusText;
        continue; // Next model try karein
      }

      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      let codes = [];

      try {
        const cleaned = rawText.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        if (Array.isArray(parsed)) codes = parsed;
      } catch {
        const matches = rawText.toUpperCase().match(/\b[A-Z]{2,5}[-\s]?[0-9]{2,4}\b/g);
        if (matches) codes = [...new Set(matches)];
      }

      return res.status(200).json({ codes, modelUsed: model });
    } catch (err) {
      lastError = err.message;
    }
  }

  return res.status(503).json({ error: `Gemini API Error: ${lastError}` });
}
