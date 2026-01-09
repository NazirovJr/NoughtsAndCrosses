export function generatePromoCode(): string {
  // Always 5 digits (10000..99999).
  return String(Math.floor(10000 + Math.random() * 90000))
}

