import * as os from 'os'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { Plugin, ServerAPI } from '@signalk/server-api'
import { WeatherProviderRegistry } from '@signalk/server-api'
import { GribStore, ScanSummary } from './grib-store'
import { PluginSettings } from './types'
import { CatalogueClient } from './catalogue'

interface PluginApp extends ServerAPI, WeatherProviderRegistry {}

const PLUGIN_ID = 'signalk-grib-weather-provider'

// "~/gribs" is not expanded by Node — resolve it ourselves.
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

const buildSchema = (defaultRoot: string) => ({
  type: 'object',
  properties: {
    inputMode: {
      type: 'string', title: 'Forecast input', enum: ['catalogue', 'local'], default: 'catalogue',
      description: 'Discover immutable GRIB datasets from Forecast Dataset Provider. Local mode reads legacy GRIB directories.',
    },
    catalogueUrl: {
      type: 'string', title: 'Forecast catalogue server URL', default: 'http://127.0.0.1:3000',
      description: 'Signal K server running Forecast Dataset Provider 0.1.x. Remote servers require HTTPS.',
    },
    catalogueTokenFile: {
      type: 'string', title: 'Readonly catalogue token file', default: '',
      description: 'Absolute path to a readonly application token. Empty uses <plugin data directory>/catalogue-token. Contents are never exposed in status or logs.',
    },
    maxAssetBytes: { type: 'integer', title: 'Maximum bytes per catalogue asset', minimum: 1, default: 2 * 1024 ** 3 },
    maxCatalogueCacheBytes: { type: 'integer', title: 'Maximum bytes in a selected catalogue snapshot', minimum: 1, default: 8 * 1024 ** 3 },
    rootDirectory: {
      type: 'string',
      title: 'Local GRIB root directory (local mode only)',
      description:
        'Every subdirectory is served as a weather provider named after the ' +
        'directory (e.g. <root>/gfs-0p25 → provider "…:gfs-0p25"). Drop GRIB2 ' +
        'files in a subdirectory — or let signalk-grib-downloader manage them. ' +
        '"~" is expanded.',
      default: defaultRoot,
    },
    cacheRoot: {
      type: 'string',
      title: 'Cache root directory (optional)',
      description:
        'Where .gribcache trees are stored, mirroring the source names. ' +
        'Defaults to the plugin data directory. Keep it outside the GRIB root.',
    },
    scanIntervalMinutes: {
      type: 'number',
      title: 'Scan interval (minutes)',
      description: 'How often to discover catalogue acquisitions (or GRIB directories in local mode)',
      default: 5,
      minimum: 1,
    },
    maxConcurrentIngests: {
      type: 'number',
      title: 'Max concurrent ingest jobs',
      description:
        'Maximum number of GRIB→cache conversions running at once. ' +
        'Each job loads full model grids in memory — keep low on small systems.',
      default: 2,
      minimum: 1,
    },
    sliceCacheSizeMB: {
      type: 'number',
      title: 'Slice cache size (MB)',
      description:
        'RAM budget for buffering decoded weather slices, reused by every ' +
        'point query. Files up to 8 MB each are cached whole; larger ' +
        '(global) slices reuse open file handles instead. Lower it on ' +
        'memory-constrained hosts.',
      default: 64,
      minimum: 1,
    },
  },
})

module.exports = (server: PluginApp): Plugin => {
  let store: GribStore | null = null
  let registered = new Set<string>()
  let lastSummary: ScanSummary = { sources: [], errors: [] }
  let inputMode: 'catalogue' | 'local' = 'catalogue'
  let catalogueUrl: string | undefined

  const DEFAULT_ROOT = '~/.signalk/gribs'

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'GRIB Weather Provider',
    schema: () => buildSchema(DEFAULT_ROOT),

    start: (options: PluginSettings) => {
      // Access the weather API directly to support one provider per source.
      const weatherApi = (server as any).weatherApi
      if (!weatherApi?.register) {
        server.setPluginError('Weather API not available — upgrade SignalK server to >=2.x')
        return
      }

      inputMode = options.inputMode ?? 'catalogue'
      if (!['catalogue', 'local'].includes(inputMode)) throw new Error('Invalid forecast input mode')
      const rootDirectory = expandHome(options.rootDirectory || DEFAULT_ROOT)
      const configuredCacheRoot = expandHome(options.cacheRoot || path.join(server.getDataDirPath(), 'cache'))
      const cacheRoot = inputMode === 'catalogue' ? path.join(configuredCacheRoot, 'catalogue') : configuredCacheRoot
      const tokenFile = expandHome(options.catalogueTokenFile || path.join(server.getDataDirPath(), 'catalogue-token'))
      if (inputMode === 'catalogue' && !path.isAbsolute(tokenFile)) throw new Error('Catalogue token file must be absolute')
      const catalogue = inputMode === 'catalogue' ? new CatalogueClient({
        url: options.catalogueUrl || 'http://127.0.0.1:3000', tokenFile,
        directory: path.join(server.getDataDirPath(), 'catalogue-assets'), cacheRoot,
        maxAssetBytes: options.maxAssetBytes, maxCacheBytes: options.maxCatalogueCacheBytes,
      }, message => server.debug(message)) : undefined
      catalogueUrl = catalogue?.endpoint
      let active: GribStore

      // Register/unregister weather providers to follow discovered sources.
      const syncProviders = (names: string[]) => {
        for (const name of names) {
          if (!registered.has(name)) {
            const providerId = `${PLUGIN_ID}:${name}`
            weatherApi.register(providerId, {
              name,
              methods: {
                getObservations: async () => [],
                getForecasts: (position: any, type: any, opts: any) =>
                  store?.getForecastsForSource(name, position, type, opts ?? {}) ?? Promise.resolve([]),
                getWarnings: async () => [],
              },
            })
            registered.add(name)
            server.debug(`Registered weather provider: ${providerId}`)
          }
        }
        for (const name of [...registered]) {
          if (!names.includes(name)) {
            weatherApi.unRegister(`${PLUGIN_ID}:${name}`)
            registered.delete(name)
            server.debug(`Unregistered weather provider: ${PLUGIN_ID}:${name}`)
          }
        }
      }

      const onScan = (summary: ScanSummary) => {
        if (store !== active) return
        lastSummary = summary
        syncProviders(summary.sources.filter(s => inputMode === 'local' || s.slices > 0).map(s => s.name))
        const parts = summary.sources.map(s => `${s.name}: ${s.slices} slice(s)`)
        if (summary.errors.length > 0) {
          server.setPluginStatus(`${parts.join(', ') || 'no sources'} — ${summary.errors.length} error(s), see debug log`)
        } else {
          server.setPluginStatus(parts.join(', ') || (inputMode === 'catalogue' ? 'no GRIB forecasts in catalogue' : `no sources found in ${rootDirectory}`))
        }
      }

      active = new GribStore(
        rootDirectory,
        cacheRoot,
        (msg: string) => server.debug(msg),
        onScan,
        {
          sourceProvider: catalogue ? signal => catalogue.refresh(signal) : undefined,
          snapshotFile: catalogue ? path.join(cacheRoot, `.weather-index-${createHash('sha256').update(catalogue.endpoint).digest('hex').slice(0, 16)}.json`) : undefined,
          maxConcurrentIngests: Math.max(1, Math.floor(options.maxConcurrentIngests ?? 2)),
          sliceCacheSizeMB: options.sliceCacheSizeMB ?? 64,
        }
      )

      store = active
      server.setPluginStatus('Starting up …')
      active.start(Math.max(1, options.scanIntervalMinutes ?? 5)).catch((err: unknown) => {
        if (store === active) server.setPluginError(`Startup error: ${err}`)
      })
    },

    stop: async () => {
      const active = store
      store = null
      const weatherApi = (server as any).weatherApi
      for (const name of registered) {
        weatherApi?.unRegister(`${PLUGIN_ID}:${name}`)
      }
      registered.clear()
      await active?.stop()
    },
    registerWithRouter(router: any) {
      router.post('/refresh', (_req: any, res: any) => {
        if (!store) return res.status(503).json({ error: 'plugin not started' })
        store.refresh().catch(error => server.debug(`Catalogue refresh failed: ${error}`))
        res.status(202).json({ started: true })
      })
      router.get('/status', (_req: any, res: any) => {
        if (!store) return res.status(503).json({ error: 'plugin not started' })
        res.json({ inputMode, catalogueUrl, ...lastSummary })
      })
    },
  }

  return plugin
}
