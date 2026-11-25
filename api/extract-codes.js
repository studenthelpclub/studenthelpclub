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
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on Vercel' });
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
                  text: `Extract all IGNOU subject/course codes from this image (examples: BEVAE-181, BCOC-131, MPA-036, BHIC-131, BEGS-186). 
Return ONLY a valid JSON array of uppercase strings. Do not include any markdown, explanation, or extra text. Example: ["BEVAE-181", "BCOC-131"]. If no codes found, return [].`
                },
                {
                  inline_data: {
                    mime_type: mimeType || 'image/jpeg',
                    data: imageBase64
                  }
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = rawText.replace(/```json|```/g, '').trim();
    const codes = JSON.parse(cleaned);

    return res.status(200).json({ codes: Array.isArray(codes) ? codes : [] });
  } catch (err) {
    console.error('Gemini Extract Error:', err);
    return res.status(500).json({ error: 'Photo scan karne me error aaya. Dobara try karein.' });
  }
}
