import { deflateSync } from "node:zlib"

const WIDTH = 360
const HEIGHT = 720

type RGB = [number, number, number]

const BG: RGB = [18, 20, 30]
const FRAME: RGB = [47, 53, 70]
const SCREEN: RGB = [10, 12, 18]
const ACCENT: RGB = [56, 130, 246]
const BAR: RGB = [52, 58, 78]
const BAR_DIM: RGB = [38, 43, 58]
const TEXT_DIM: RGB = [96, 104, 128]

const pixels = new Uint8Array(WIDTH * HEIGHT * 4)

function setPixel(x: number, y: number, [r, g, b]: RGB, alpha = 255) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return
  const i = (y * WIDTH + x) * 4
  pixels[i] = r
  pixels[i + 1] = g
  pixels[i + 2] = b
  pixels[i + 3] = alpha
}

function fillRect(x0: number, y0: number, x1: number, y1: number, color: RGB) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      setPixel(x, y, color)
    }
  }
}

function fillRoundedRect(x0: number, y0: number, x1: number, y1: number, radius: number, color: RGB) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius - 1))
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius - 1))
      if (dx * dx + dy * dy <= radius * radius) setPixel(x, y, color)
    }
  }
}

function fillCircle(cx: number, cy: number, r: number, color: RGB) {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) setPixel(x, y, color)
    }
  }
}

function draw() {
  fillRect(0, 0, WIDTH, HEIGHT, BG)
  // phone frame
  fillRoundedRect(28, 48, WIDTH - 28, HEIGHT - 48, 36, FRAME)
  // screen
  fillRoundedRect(44, 64, WIDTH - 44, HEIGHT - 64, 24, SCREEN)
  // status bar: time pill + dots
  fillRoundedRect(70, 84, 130, 98, 7, BAR_DIM)
  fillCircle(300, 88, 3, BAR_DIM)
  fillCircle(312, 88, 3, BAR_DIM)
  fillCircle(324, 88, 3, BAR_DIM)
  // camera notch
  fillCircle(WIDTH / 2, 76, 4, FRAME)
  // skeleton placeholder bars on screen
  const skeleton = [
    [64, 130, 296, 150],
    [64, 170, 220, 190],
    [64, 210, 296, 230],
    [64, 250, 250, 270],
    [64, 290, 296, 330],
    [64, 350, 200, 380],
    [64, 400, 296, 440],
    [64, 460, 240, 490],
  ] as const
  for (const [x0, y0, x1, y1] of skeleton) {
    fillRoundedRect(x0, y0, x1, y1, 10, BAR)
  }
  // an accent "screenshot" area
  fillRoundedRect(64, 510, 296, 600, 14, ACCENT)
  fillRoundedRect(84, 540, 276, 566, 8, [37, 99, 235])
  // home indicator
  fillRoundedRect(WIDTH / 2 - 60, HEIGHT - 86, WIDTH / 2 + 60, HEIGHT - 80, 3, TEXT_DIM)
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

export function renderPlaceholderPng(): Buffer {
  draw()
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(WIDTH, 0)
  ihdr.writeUInt32BE(HEIGHT, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT)
  for (let y = 0; y < HEIGHT; y++) {
    raw[y * (WIDTH * 4 + 1)] = 0
    Buffer.from(pixels.buffer, y * WIDTH * 4, WIDTH * 4).copy(raw, y * (WIDTH * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}
