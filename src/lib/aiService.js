const aiApiUrl = import.meta.env.VITE_AI_API_URL || '/api/ai/reveal'

export async function requestReveal(payload, signal) {
  const response = await fetch(aiApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  })

  if (!response.ok) {
    throw new Error(`AI endpoint returned ${response.status}`)
  }

  return response.json()
}
