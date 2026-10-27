// The session cookie (docs/security/identity-and-access.md §4; ASVS 5.0.0
// V3.3). Over https: `__Host-wam_session` with Secure. Plain http (allowed
// only outside production, see config.ts): `wam_session` without Secure,
// because browsers refuse both the prefix and the attribute there.

export interface CookieSettings {
  readonly name: string
  readonly secure: boolean
}

export function cookieSettingsFor(publicOrigin: string): CookieSettings {
  return publicOrigin.startsWith('https://')
    ? { name: '__Host-wam_session', secure: true }
    : { name: 'wam_session', secure: false }
}

/**
 * The value of cookie `name`, or null if absent — and also null if it occurs
 * more than once, which only happens when something else has planted a second
 * cookie of that name (cookie tossing); refusing is safer than guessing.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null
  let found: string | null = null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue
    if (found !== null) return null
    found = part.slice(eq + 1).trim()
  }
  return found === '' ? null : found
}

function attributes(settings: CookieSettings): string {
  return `Path=/; HttpOnly; SameSite=Strict${settings.secure ? '; Secure' : ''}`
}

/** A browser-session cookie: no Max-Age, so it ends with the browser session; the server enforces the real lifetime. */
export function sessionCookie(settings: CookieSettings, token: string): string {
  return `${settings.name}=${token}; ${attributes(settings)}`
}

export function clearedSessionCookie(settings: CookieSettings): string {
  return `${settings.name}=; Max-Age=0; ${attributes(settings)}`
}
