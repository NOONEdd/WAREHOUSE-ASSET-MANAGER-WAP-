// Test-only: reads authenticator secrets the way an authenticator app does.

/** RFC 4648 base32 (no padding). */
export function base32Decode(text: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text) {
    const index = alphabet.indexOf(char)
    if (index === -1) throw new Error(`not base32: ${char}`)
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}
