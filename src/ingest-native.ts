import * as path from 'path'
import * as fs from 'fs'
import { spawn } from 'child_process'
import { promisify } from 'util'

const exec = promisify(require('child_process').exec)

// Path to the Python conversion script (relative to package root)
const PYTHON_SCRIPT = path.join(__dirname, '..', 'eccodes-container', 'grib2cache.py')

/**
 * Check if native ecCodes is available (Python + eccodes module)
 */
export async function hasNativeEcCodes(log: (msg: string) => void): Promise<boolean> {
  try {
    // Check if python3 is available
    const pythonCheck = await exec('python3 --version')
    log(`Python found: ${pythonCheck.stdout.trim()}`)

    // Check if eccodes module is importable
    const eccodesCheck = await exec('python3 -c "import eccodes; print(eccodes.codes_get_version_info())"')
    log(`ecCodes found: ${eccodesCheck.stdout.trim()}`)

    return true
  } catch (err: any) {
    log(`Native ecCodes not available: ${err.message}`)
    return false
  }
}

/**
 * Ingest a GRIB file using native Python ecCodes.
 * Produces one .gribcache file per validity time in cacheDir.
 */
export async function ingestGribNative(
  gribPath: string,
  cacheDir: string,
  log: (msg: string) => void
): Promise<boolean> {
  // Ensure cache directory exists
  await fs.promises.mkdir(cacheDir, { recursive: true })

  // Check if Python script exists
  if (!fs.existsSync(PYTHON_SCRIPT)) {
    throw new Error(`Python script not found: ${PYTHON_SCRIPT}`)
  }

  // Spawn Python process
  const proc = spawn('python3', [PYTHON_SCRIPT, gribPath, cacheDir])

  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (data) => {
      const line = data.toString()
      stdout += line
      // Log each line for progress tracking
      for (const l of line.split('\n').filter((x: string) => x)) {
        log(`  native: ${l}`)
      }
    })

    proc.stderr.on('data', (data) => {
      const line = data.toString()
      stderr += line
      for (const l of line.split('\n').filter((x: string) => x)) {
        log(`  native error: ${l}`)
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        // Verify at least one .gribcache file was created
        const base = path.basename(gribPath, path.extname(gribPath))
        const produced = fs.readdirSync(cacheDir).some(f => {
          const m = /^.+\.t\d{12}\.gribcache$/.exec(f)
          return m !== null && f.startsWith(base + '.t')
        })
        if (produced) {
          log(`Native ingest complete: ${path.basename(gribPath)}`)
          resolve(true)
        } else {
          reject(new Error('Python completed but no .gribcache file was created'))
        }
      } else {
        reject(new Error(`Python process exited with code ${code}: ${stderr}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Python process: ${err}`))
    })
  })
}