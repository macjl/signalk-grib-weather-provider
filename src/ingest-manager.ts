import * as path from 'path'
import * as fs from 'fs'

const PLUGIN_ID = 'signalk-grib-weather-provider'
const DEFAULT_IMAGE = 'signalk-grib-eccodes:latest'

// Tracks GRIB files currently being ingested to prevent duplicate jobs.
const pending = new Set<string>()

function containerManager(): any {
  return (globalThis as any).__signalk_containerManager ?? null
}

// Returns the path of the .gribcache file produced from a GRIB file, or null if not yet ingested.
export function cachePathFor(gribPath: string, cacheDir: string): string {
  const basename = path.basename(gribPath, path.extname(gribPath))
  return path.join(cacheDir, basename + '.gribcache')
}

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

// Ingest a GRIB file into a .gribcache file if not already done.
// Returns the .gribcache path on success, null if already in progress.
export async function ingestGrib(
  gribPath: string,
  cacheDir: string,
  image: string,
  log: (m: string) => void
): Promise<string | null> {
  const cachePath = cachePathFor(gribPath, cacheDir)

  // Already ingested?
  if (fs.existsSync(cachePath)) return cachePath

  // Already in progress?
  if (pending.has(gribPath)) return null

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

    const gribBasename = path.basename(gribPath)
    const inGribPath  = rGrib.subPath  ? `${rGrib.subPath}/${gribBasename}` : gribBasename
    const outDir      = rCache.subPath ? `/${rCache.subPath}` : '/'

    // runJob: read GRIB → write .gribcache
    // Use separate container mounts even if they resolve to the same host source.
    const volumes: Record<string, string> = {
      '/grib-in': rGrib.source,
    }
    const outputVolumes: Record<string, string> = {
      '/cache-out': rCache.source,
    }

    const result = await containers.runJob({
      image,
      command: [
        'python3', '/app/grib2cache.py',
        `/grib-in/${inGribPath}`,
        `/cache-out${outDir}`,
      ],
      inputs:  volumes,
      outputs: outputVolumes,
      timeout: 180,
      ownerPluginId: PLUGIN_ID,
      onProgress: (line: string) => log(`  eccodes: ${line}`),
    })

    if (result.status !== 'completed' || result.exitCode !== 0) {
      throw new Error(`Ingest job failed (exit ${result.exitCode}): ${result.log?.slice(-500)}`)
    }

    if (!fs.existsSync(cachePath)) {
      throw new Error(`Job completed but ${cachePath} was not created`)
    }

    log(`Ingest complete: ${path.basename(cachePath)}`)
    return cachePath
  } finally {
    pending.delete(gribPath)
  }
}

export const DEFAULT_ECCODES_IMAGE = DEFAULT_IMAGE
