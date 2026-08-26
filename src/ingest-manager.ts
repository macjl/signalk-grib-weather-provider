import * as path from 'path'
import * as fs from 'fs'
import { ingestGribWasm } from './ingest-wasm'

const MAX_INGEST_ATTEMPTS = 5

// Tracks GRIB files currently being ingested to prevent duplicate jobs.
const pending = new Set<string>()
// Failed ingest attempts per GRIB path — abandoned after MAX_INGEST_ATTEMPTS.
const failures = new Map<string, number>()

// Strip the GRIB extension from a file path → cache basename.
export function gribBasename(gribPath: string): string {
  return path.basename(gribPath, path.extname(gribPath))
}

// Cache files are named <basename>.t<YYYYMMDDHHMM>.gribcache — one per validity time.
export const CACHE_FILE_RE = /^(.+)\.t(\d{12})\.gribcache$/

// Ingest a GRIB file: produces one .gribcache per validity time in cacheDir.
// Conversion runs in-process via the WebAssembly build of ecCodes.
// Returns true on success, false if skipped (in progress or too many failures).
// Throws on failure (counted against MAX_INGEST_ATTEMPTS).
export async function ingestGrib(
  gribPath: string,
  cacheDir: string,
  log: (m: string) => void
): Promise<boolean> {
  if (pending.has(gribPath)) return false

  const failCount = failures.get(gribPath) ?? 0
  if (failCount >= MAX_INGEST_ATTEMPTS) {
    if (failCount === MAX_INGEST_ATTEMPTS) {
      log(`Giving up on ${path.basename(gribPath)} after ${MAX_INGEST_ATTEMPTS} failed attempts`)
      failures.set(gribPath, failCount + 1)  // log only once
    }
    return false
  }

  pending.add(gribPath)
  try {
    log(`Ingesting ${path.basename(gribPath)} …`)
    await ingestGribWasm(gribPath, cacheDir, log)

    // Success = at least one slice produced for this basename
    const base = gribBasename(gribPath)
    const produced = fs.readdirSync(cacheDir).some(f => {
      const m = CACHE_FILE_RE.exec(f)
      return m !== null && m[1] === base
    })
    if (!produced) {
      throw new Error(`Ingest completed but no .gribcache file was created for ${base}`)
    }

    failures.delete(gribPath)
    log(`Ingest complete: ${path.basename(gribPath)}`)
    return true
  } catch (err) {
    failures.set(gribPath, failCount + 1)
    throw err
  } finally {
    pending.delete(gribPath)
  }
}
