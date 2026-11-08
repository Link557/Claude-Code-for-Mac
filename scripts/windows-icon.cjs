// Run with: node scripts/launch.cjs electron scripts/windows-icon.cjs
// Keep the Mac artwork's proportions; fit the solid tile, not its faint outer
// shadow, to Windows taskbar slots (the shadow otherwise consumes icon space).
const { app, nativeImage } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { resolve } = require('node:path')
const source = readFileSync(resolve(__dirname, '../build/icon.icns'))
const sizes = new Map()
if (source.toString('ascii', 0, 4) !== 'icns') throw Error('Expected the Mac ICNS icon')
for (let offset = 8; offset < source.length;) {
  const length = source.readUInt32BE(offset + 4)
  if (length < 8 || offset + length > source.length) throw Error('Invalid ICNS layer')
  const png = source.subarray(offset + 8, offset + length)
  if (png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20)
    if (width === height && width <= 256) sizes.set(width, png)
  }
  offset += length
}
if (!sizes.has(256)) throw Error('Missing the 256px icon layer')
const original = nativeImage.createFromBuffer(sizes.get(256))
const bitmap = original.toBitmap()
let left = 256, top = 256, right = 0, bottom = 0
for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
  if (bitmap[(y * 256 + x) * 4 + 3] >= 240) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y) }
}
// Square crop preserves the aspect ratio of the tile and its internal mark.
const edge = Math.max(right - left + 1, bottom - top + 1)
const fitted = original.crop({ x: Math.floor((left + right + 1 - edge) / 2), y: Math.floor((top + bottom + 1 - edge) / 2), width: edge, height: edge })
const layers = [16, 24, 32, 48, 64, 128, 256].map(size => [size, fitted.resize({ width: size, height: size, quality: 'best' }).toPNG()])
const header = Buffer.alloc(6 + layers.length * 16)
header.writeUInt16LE(1, 2); header.writeUInt16LE(layers.length, 4)
let position = header.length
layers.forEach(([size, png], i) => {
  const offset = 6 + i * 16
  header[offset] = header[offset + 1] = size === 256 ? 0 : size
  header.writeUInt16LE(1, offset + 4); header.writeUInt16LE(32, offset + 6)
  header.writeUInt32LE(png.length, offset + 8); header.writeUInt32LE(position, offset + 12)
  position += png.length
})
writeFileSync(resolve(__dirname, '../build/icon.ico'), Buffer.concat([header, ...layers.map(([, png]) => png)]))
console.log('Windows icon fitted from Mac artwork: ' + layers.map(([size]) => size).join(', '))
app.exit(0)
