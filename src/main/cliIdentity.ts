import { statSync } from 'node:fs'

/** Shared executable identity for metadata and command catalog cache keys. */
export function cliFileIdentity(path: string): string {
  try {
    const info = statSync(path)
    return JSON.stringify([path, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs])
  } catch {
    return JSON.stringify([path, 'missing'])
  }
}
