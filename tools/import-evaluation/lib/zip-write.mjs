import { crc32, deflateRawSync } from 'node:zlib'

// Minimal ZIP writer for the synthetic corpus. Every field can be overridden so
// that hostile archives (lying sizes, symlinks, encryption flags, bad names,
// ZIP64 markers) can be built byte by byte. Never used on real data.

/**
 * @param {Array<{name: string, data: Buffer|string, method?: 0|8, level?: number,
 *   crc?: number, usize?: number, flags?: number, madeBy?: number, externalAttr?: number, methodOverride?: number}>} entries
 * @param {{entryCount?: number, zip64Locator?: boolean, truncate?: number}} [options]
 */
export function writeZip(entries, options = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const method = entry.method ?? 8
    const body = method === 8 ? deflateRawSync(data, { level: entry.level ?? 6 }) : data
    const name = Buffer.from(entry.name, 'utf8')
    const flags = (entry.flags ?? 0) | 0x800
    const declared = entry.methodOverride ?? method
    const crc = entry.crc ?? crc32(data)
    const usize = entry.usize ?? data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(declared, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(body.length >>> 0, 18)
    local.writeUInt32LE(usize >>> 0, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.madeBy ?? 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(declared, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(body.length >>> 0, 20)
    central.writeUInt32LE(usize >>> 0, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((entry.externalAttr ?? 0) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const tail = []
  if (options.zip64Locator === true) {
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    tail.push(locator)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  const count = options.entryCount ?? entries.length
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  tail.push(end)
  const zip = Buffer.concat([...locals, cd, ...tail])
  return options.truncate === undefined ? zip : zip.subarray(0, options.truncate)
}
