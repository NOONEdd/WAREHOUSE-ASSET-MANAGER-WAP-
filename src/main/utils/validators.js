import { assetRepository } from '../repositories/assetRepository'

/**
 * Never allow duplicate Serial Numbers or Asset Codes (Phase 1). Checked
 * here, server-side, rather than trusted to the UI alone — the database's
 * own UNIQUE constraints are the last line of defense, but this is what
 * turns a raw constraint violation into the user-friendly message Phase 1
 * asked for.
 *
 * excludeId is passed on update, so an asset doesn't collide with itself.
 */
function checkDuplicateAssetCodeOrSerial(assetCode, serialNumber, excludeId) {
  const match = assetRepository.findByCodeOrSerial(assetCode, serialNumber)
  if (!match || match.id === excludeId) return null

  if (match.asset_code === assetCode) {
    return `کد دارایی «${assetCode}» قبلاً برای دارایی دیگری ثبت شده است`
  }
  return `شماره سریال «${serialNumber}» قبلاً برای دارایی دیگری ثبت شده است`
}

function requireFields(fields, values) {
  const missing = fields.filter((f) => !values[f] && values[f] !== 0)
  if (missing.length > 0) {
    return 'لطفاً فیلدهای الزامی را تکمیل کنید'
  }
  return null
}

/**
 * First-Run Security phase — the one password-strength rule shared by
 * both first-run setup and the regular password-change form, so the two
 * flows can never silently drift apart. Deliberately just length +
 * "not the username": mandatory symbol/number complexity rules are a
 * well-documented way to push people toward WORSE, more predictable
 * passwords (a longer passphrase they can actually remember beats
 * "Passw0rd!" satisfying a character-class checklist), and this app's
 * own threat model — a single local admin account, offline desktop app —
 * doesn't call for that trade-off. Compared case-insensitively so
 * "Admin" doesn't slip through against a username of "admin".
 */
function validatePassword(password, username) {
  if (!password || password.length < 8) {
    return 'رمز عبور باید حداقل ۸ کاراکتر باشد'
  }
  if (username && password.toLowerCase() === String(username).toLowerCase()) {
    return 'رمز عبور نمی‌تواند با نام کاربری یکسان باشد'
  }
  return null
}

export { checkDuplicateAssetCodeOrSerial, requireFields, validatePassword }
