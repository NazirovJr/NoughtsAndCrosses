export type TelegramPayload =
  | { event: 'win'; promo: string; linkCode?: string }
  | { event: 'loss'; linkCode?: string }

export async function sendTelegram(payload: TelegramPayload): Promise<void> {
  const res = await fetch('/api/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const details = await res.text().catch(() => '')
    throw new Error(details || `Telegram request failed (${res.status})`)
  }
}

