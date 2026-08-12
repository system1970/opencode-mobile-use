import { deflateSync, inflateSync } from "node:zlib"

// ── PNG decode / encode / overlay helpers (pure JS, no deps) ───────────────

export interface DecodedPng {
  width: number
  height: number
  rgba: Buffer
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, "ascii")
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Decode a non-interlaced 8-bit RGB(A) PNG into an RGBA buffer. */
export function decodePng(png: Buffer): DecodedPng {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG")
  }
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  let off = 8
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off)
    const type = png.toString("ascii", off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`)
      if (data[12] !== 0) throw new Error("interlaced PNG unsupported")
    } else if (type === "IDAT") {
      idat.push(data)
    } else if (type === "IEND") {
      break
    }
    off += 12 + len
  }
  if (!width || !height) throw new Error("invalid PNG header")
  if (colorType !== 2 && colorType !== 6) {
    throw new Error(`unsupported color type ${colorType}`)
  }
  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = Buffer.concat(idat)
  const inflated = inflateSync(raw)
  if (inflated.length < (stride + 1) * height) throw new Error("truncated pixel data")
  const rgba = Buffer.alloc(width * height * 4)
  let src = 0
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]
    const rowStart = src
    for (let x = 0; x < stride; x++) {
      const i = src + x
      let v = inflated[i]
      const left = x >= bpp ? inflated[i - bpp] : 0
      const up = y > 0 ? inflated[i - (stride + 1)] : 0
      const upLeft = y > 0 && x >= bpp ? inflated[i - (stride + 1) - bpp] : 0
      if (filter === 1) v = (v + left) & 0xff
      else if (filter === 2) v = (v + up) & 0xff
      else if (filter === 3) v = (v + ((left + up) >> 1)) & 0xff
      else if (filter === 4) v = (v + paeth(left, up, upLeft)) & 0xff
      inflated[i] = v
    }
    for (let x = 0; x < width; x++) {
      const si = rowStart + x * bpp
      const di = (y * width + x) * 4
      rgba[di] = inflated[si]
      rgba[di + 1] = inflated[si + 1]
      rgba[di + 2] = inflated[si + 2]
      rgba[di + 3] = colorType === 6 ? inflated[si + 3] : 255
    }
    src += stride
  }
  return { width, height, rgba }
}

/** Encode an RGBA buffer as a PNG (color type 6, 8-bit). */
export function encodePng(rgba: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Box-average downscale keeping aspect ratio, bounded by the long edge. */
export function downscale(
  rgba: Buffer,
  width: number,
  height: number,
  maxLongEdge: number,
): { rgba: Buffer; width: number; height: number } {
  const long = Math.max(width, height)
  if (long <= maxLongEdge) return { rgba, width, height }
  const scale = long / maxLongEdge
  const tw = Math.max(1, Math.round(width / scale))
  const th = Math.max(1, Math.round(height / scale))
  const out = Buffer.alloc(tw * th * 4)
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor((ty * height) / th)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / th))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor((tx * width) / tw)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / tw))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4
          r += rgba[i]
          g += rgba[i + 1]
          b += rgba[i + 2]
          a += rgba[i + 3]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const di = (ty * tw + tx) * 4
      out[di] = r / n
      out[di + 1] = g / n
      out[di + 2] = b / n
      out[di + 3] = a / n
    }
  }
  return { rgba: out, width: tw, height: th }
}

// ── SoM overlay (Set-of-Marks, AppAgent-style): numbered boxes on elements ──

const OUTLINE: [number, number, number] = [255, 200, 60]
const TAG_FILL: [number, number, number] = [255, 130, 30]
const TAG_TEXT: [number, number, number] = [255, 255, 255]

// 3x5 bitmap digits
const DIGITS: number[][] = [
  [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1], // 0
  [0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1], // 1
  [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1], // 2
  [1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1], // 3
  [1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1], // 4
  [1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1], // 5
  [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], // 7
  [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1], // 9
]

interface OverlayRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** Draw numbered SoM overlays for the given element bounds (device pixels). */
export function annotate(
  rgba: Buffer,
  width: number,
  height: number,
  rects: Array<OverlayRect | null>,
  maxTags = 24,
): void {
  const tagScale = Math.max(2, Math.round(width / 360))
  const digitW = 3 * tagScale
  const digitH = 5 * tagScale
  const pad = tagScale

  const putRect = (x0: number, y0: number, x1: number, y1: number, color: [number, number, number]) => {
    for (let y = y0; y < y1; y++) {
      if (y < 0 || y >= height) continue
      for (let x = x0; x < x1; x++) {
        if (x < 0 || x >= width) continue
        const i = (y * width + x) * 4
        rgba[i] = color[0]
        rgba[i + 1] = color[1]
        rgba[i + 2] = color[2]
        rgba[i + 3] = 255
      }
    }
  }

  const putDigit = (dx: number, dy: number, digit: number) => {
    const cells = DIGITS[digit]
    for (let cy = 0; cy < 5; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        if (!cells[cy * 3 + cx]) continue
        putRect(dx + cx * tagScale, dy + cy * tagScale, dx + (cx + 1) * tagScale, dy + (cy + 1) * tagScale, TAG_TEXT)
      }
    }
  }

  let drawn = 0
  for (const rect of rects) {
    if (!rect || drawn >= maxTags) continue
    const { left, top, right, bottom } = rect
    if (right - left < 8 || bottom - top < 8) continue
    const o = Math.max(1, Math.round(tagScale / 2))
    putRect(left - o, top - o, right + o, top, OUTLINE)
    putRect(left - o, bottom, right + o, bottom + o, OUTLINE)
    putRect(left - o, top - o, left, bottom + o, OUTLINE)
    putRect(right, top - o, right + o, bottom + o, OUTLINE)
    const text = String(drawn)
    const tagW = text.length * digitW + pad * 2
    const tagH = digitH + pad * 2
    const tx = Math.max(0, Math.min(width - tagW, left - o))
    const ty = Math.max(0, Math.min(height - tagH, top - tagH - o))
    putRect(tx, ty, tx + tagW, ty + tagH, TAG_FILL)
    for (let i = 0; i < text.length; i++) {
      putDigit(tx + pad + i * digitW, ty + pad, Number(text[i]))
    }
    drawn++
  }
}

/** Decode a screenshot, draw SoM overlays, re-encode. Returns the PNG buffer. */
export function annotateScreenshot(png: Buffer, rects: Array<OverlayRect | null>): Buffer {
  const { width, height, rgba } = decodePng(png)
  annotate(rgba, width, height, rects)
  return encodePng(rgba, width, height)
}
