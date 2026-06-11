// A source is a subdirectory of rootDirectory, discovered at scan time.
// Its directory name is the provider ID suffix and display name.
export interface SourceConfig {
  name: string         // directory name — provider ID suffix and index key
  directory: string    // <rootDirectory>/<name>
  cacheDirectory: string  // <cacheRoot>/<name>
}

export interface PluginSettings {
  rootDirectory?: string         // parent directory of all GRIB sources
  cacheRoot?: string             // where .gribcache trees live (default: plugin data dir)
  scanIntervalMinutes?: number
  maxConcurrentIngests?: number  // cap on simultaneous GRIB→cache container jobs
  eccodesImage?: string          // Docker image for the eccodes container
}

export interface GridMeta {
  latFirst: number           // latitude of first grid row (degrees)
  lonFirst: number           // longitude of first grid column (degrees)
  dLat: number               // grid step in latitude (degrees, always positive)
  dLon: number               // grid step in longitude (degrees, always positive)
  nLat: number               // number of rows
  nLon: number               // number of columns
  jScansPositively: boolean  // true = S→N (j=0 is south), false = N→S (j=0 is north)
}

// Parsed header of a .gribcache file — no data in RAM
export interface CacheFileMeta {
  validAt: Date
  refTime: Date | null                 // model run reference time (dedup across runs)
  precipAccum: [number, number] | null // precip accumulation window [startStep, endStep] in forecast hours
  grid: GridMeta
  vars: string[]    // ordered list of field names matching the float32 layout
  nVars: number
  dataStart: number // byte offset where float32 data begins
}

export interface CacheEntry {
  filePath: string
  meta: CacheFileMeta
}

export interface TimeSlice {
  validAt: Date
  values: Record<string, number>  // field name → SI-unit value
}
