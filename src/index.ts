import * as os from 'os'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { Plugin, ServerAPI } from '@signalk/server-api'
import { WeatherProviderRegistry } from '@signalk/server-api'
import { GribStore, ScanSummary } from './grib-store'
import { PluginSettings } from './types'
import { CatalogueClient, LOCAL_CATALOGUE_CACHE_KEY, WAITING_FOR_LOCAL_CATALOGUE } from './catalogue'

interface PluginApp extends ServerAPI, WeatherProviderRegistry {}

const PLUGIN_ID = 'signalk-grib-weather-provider'

// "~/gribs" is not expanded by Node — resolve it ourselves.
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

const buildSchema = () => ({
  type: 'object',
  properties: {
    maxAssetMB: { type: 'number', title: 'Maximum size per catalogue asset (MB)', description: '1 MB = 1,000,000 bytes. Decimal values are allowed.', minimum: 0.000001, default: 2000 },
    maxCatalogueCacheMB: { type: 'number', title: 'Maximum size of selected catalogue assets (MB)', description: 'Combined original file sizes in one selected snapshot, not a global disk quota. 1 MB = 1,000,000 bytes.', minimum: 0.000001, default: 8000 },
    cacheRoot: {
      type: 'string',
      title: 'Cache root directory (optional)',
      description:
        'Where .gribcache trees are stored, mirroring the source names. ' +
        'Defaults to the plugin data directory; the catalogue/ child holds decoded acquisitions.',
    },
    scanIntervalMinutes: {
      type: 'number',
      title: 'Scan interval (minutes)',
      description: 'How often to discover catalogue acquisitions',
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
  let catalogue: CatalogueClient | null = null
  let localTimer: ReturnType<typeof setInterval> | undefined

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'GRIB Weather Provider',
    schema: buildSchema,

    start: (options: PluginSettings) => {
      // Access the weather API directly to support one provider per source.
      const weatherApi = (server as any).weatherApi
      if (!weatherApi?.register) {
        server.setPluginError('Weather API not available — upgrade SignalK server to >=2.x')
        return
      }

      const dataDir = server.getDataDirPath()
      const configuredCacheRoot = expandHome(options.cacheRoot || path.join(dataDir, 'cache'))
      const cacheRoot = path.join(configuredCacheRoot, 'catalogue')
      const client = new CatalogueClient({
        localScope: path.dirname(dataDir),
        directory: path.join(dataDir, 'catalogue-assets'), cacheRoot,
        maxAssetMB: options.maxAssetMB, maxCatalogueCacheMB: options.maxCatalogueCacheMB,
      }, message => server.debug(message))
      catalogue = client

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
        syncProviders(summary.sources.filter(s => s.slices > 0).map(s => s.name))
        if (client.connection === 'waiting') {
          server.setPluginStatus(WAITING_FOR_LOCAL_CATALOGUE)
          return
        }
        const parts = summary.sources.map(s => `${s.name}: ${s.slices} slice(s)`)
        if (summary.errors.length > 0) {
          server.setPluginStatus(`${parts.join(', ') || 'no sources'} — ${summary.errors.length} error(s), see debug log`)
        } else {
          server.setPluginStatus(parts.join(', ') || 'no GRIB forecasts in catalogue')
        }
      }

      const active = new GribStore(
        cacheRoot,
        (msg: string) => server.debug(msg),
        onScan,
        {
          sourceProvider: signal => client.refresh(signal),
          snapshotFile: path.join(cacheRoot, `.weather-index-${createHash('sha256').update(LOCAL_CATALOGUE_CACHE_KEY).digest('hex').slice(0, 16)}.json`),
          maxConcurrentIngests: Math.max(1, Math.floor(options.maxConcurrentIngests ?? 2)),
          sliceCacheSizeMB: options.sliceCacheSizeMB ?? 64,
        }
      )

      store = active
      server.setPluginStatus('Starting up …')
      let connection = client.connection
      const initialScan = active.start(Math.max(1, options.scanIntervalMinutes ?? 5)).catch((err: unknown) => {
        if (store === active) server.setPluginError(`Startup error: ${err}`)
      })
      localTimer = setInterval(() => {
        const current = client.connection
        if (current === connection) return
        connection = current
        void initialScan.then(() => {
          if (store === active) return active.refresh()
        }).catch(error => server.debug(`Catalogue refresh failed: ${error}`))
      }, 2_000)
    },

    stop: async () => {
      const active = store
      store = null
      catalogue = null
      clearInterval(localTimer)
      localTimer = undefined
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
        if (!store || !catalogue) return res.status(503).json({ error: 'plugin not started' })
        res.json({ inputMode: 'catalogue', catalogueTransport: catalogue.connection, ...lastSummary })
      })
    },
  }

  return plugin
}
