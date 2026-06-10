import * as path from 'path'
import * as fs from 'fs'

const PLUGIN_ID = 'signalk-grib-weather-provider'
const DEFAULT_IMAGE = 'ghcr.io/macjl/signalk-grib-eccodes:latest'
const MAX_INGEST_ATTEMPTS = 5

// Tracks GRIB files currently being ingested to prevent duplicate jobs.
const pending = new Set<string>()
// Failed ingest attempts per GRIB path — abandoned after MAX_INGEST_ATTEMPTS.
const failures = new Map<string, number>()

function containerManager(): any {
  return (globalThis as any).__signalk_containerManager ?? null
}

// Strip the GRIB extension from a file path → cache basename.
export function gribBasename(gribPath: string): string {
  return path.basename(gribPath, path.extname(gribPath))
}

// Cache files are named <basename>.t<YYYYMMDDHHMM>.gribcache — one per validity time.
export const CACHE_FILE_RE = /^(.+)\.t(\d{12})\.gribcache$/

// Ensure the eccodes container image is available. Must be called after containers.whenReady().
export async function ensureImage(image: string, log: (m: string) => void): Promise<void> {
  const containers = containerManager()
  if (!containers) throw new Error('signalk-container not available')

  const exists = await containers.imageExists(image)
  if (!exists) {
    log(`Pulling eccodes image ${image} …`)
    await containers.pullImage(image, (line: string) => log(`  pull: ${line}`))
    log(`Image ${image} ready`)
  }
}

// Ingest a GRIB file: produces one .gribcache per validity time in cacheDir.
// Returns true on success, false if skipped (in progress or too many failures).
// Throws on failure (counted against MAX_INGEST_ATTEMPTS).
export async function ingestGrib(
  gribPath: string,
  cacheDir: string,
  image: string,
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

  const containers = containerManager()
  if (!containers) throw new Error('signalk-container not available')

  pending.add(gribPath)
  try {
    log(`Ingesting ${path.basename(gribPath)} …`)

    // Resolve GRIB directory for container volume mounting
    const gribDir = path.dirname(gribPath)
    const rGrib = await containers.resolveHostPath(gribDir)
    if (!rGrib) {
      throw new Error(
        `GRIB directory "${gribDir}" is not reachable from the container runtime. ` +
        `Move it inside the SignalK data directory or bind-mount it into the SignalK container.`
      )
    }

    // Resolve cache directory (may be the same volume as grib dir)
    await fs.promises.mkdir(cacheDir, { recursive: true })
    const rCache = await containers.resolveHostPath(cacheDir)
    if (!rCache) {
      throw new Error(
        `Cache directory "${cacheDir}" is not reachable from the container runtime.`
      )
    }

    const gribFile   = path.basename(gribPath)
    const inGribPath = rGrib.subPath  ? `${rGrib.subPath}/${gribFile}` : gribFile
    const outDir     = rCache.subPath ? `/${rCache.subPath}` : '/'

    // runJob: read GRIB → write one .gribcache per validity time
    const result = await containers.runJob({
      image,
      command: [
        'python3', '/app/grib2cache.py',
        `/grib-in/${inGribPath}`,
        `/cache-out${outDir}`,
      ],
      inputs:  { '/grib-in': rGrib.source },
      outputs: { '/cache-out': rCache.source },
      timeout: 180,
      ownerPluginId: PLUGIN_ID,
      onProgress: (line: string) => log(`  eccodes: ${line}`),
    })

    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new Error(`Ingest job failed (exit ${result.exitCode}): ${result.log?.slice(-500)}`)
    }

    // Success = at least one slice produced for this basename
    const base = gribBasename(gribPath)
    const produced = fs.readdirSync(cacheDir).some(f => {
      const m = CACHE_FILE_RE.exec(f)
      return m !== null && m[1] === base
    })
    if (!produced) {
      throw new Error(`Job completed but no .gribcache file was created for ${base}`)
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

export const DEFAULT_ECCODES_IMAGE = DEFAULT_IMAGE
