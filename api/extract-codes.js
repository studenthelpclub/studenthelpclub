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

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        })
      }
    );

    const data = await response.json();

    // Agar Gemini API se koi error aaye toh asli error dikhaye
    if (!response.ok) {
      return res.status(500).json({
        error: `Gemini API Error: ${data?.error?.message || response.statusText}`
      });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let codes = [];

    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) codes = parsed;
    } catch {
      // Fallback: agar JSON parse fail ho toh regex se codes nikal le
      const matches = rawText.toUpperCase().match(/\b[A-Z]{2,5}[-\s]?[0-9]{2,4}\b/g);
      if (matches) codes = [...new Set(matches)];
    }

    return res.status(200).json({ codes });
  } catch (err) {
    console.error('Gemini Extract Error:', err);
    return res.status(500).json({ error: `Server Error: ${err.message}` });
  }
}
