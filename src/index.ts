import * as os from 'os'
import * as path from 'path'
import { createHash } from 'node:crypto'
import { Plugin, ServerAPI } from '@signalk/server-api'
import { WeatherProviderRegistry } from '@signalk/server-api'
import { GribStore, ScanSummary } from './grib-store'
import { PluginSettings } from './types'
import { CatalogueClient } from './catalogue'
import { CatalogueAccess } from './catalogue-access'

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
    catalogueUrl: {
      type: 'string', title: 'Forecast catalogue server URL', default: 'http://127.0.0.1:3000',
      description: 'Signal K server running Forecast Dataset Provider 0.1.x. Remote servers require HTTPS.',
    },
    catalogueTokenFile: {
      type: 'string', title: 'Readonly catalogue token file', default: '',
      description: 'Token file, default <plugin data directory>/catalogue-token. When missing, approve the automatic readonly request in Signal K Security > Access Requests. Contents are never exposed in status or logs.',
    },
    maxAssetBytes: { type: 'integer', title: 'Maximum bytes per catalogue asset', minimum: 1, default: 2 * 1024 ** 3 },
    maxCatalogueCacheBytes: { type: 'integer', title: 'Maximum bytes in a selected catalogue snapshot', minimum: 1, default: 8 * 1024 ** 3 },
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
  let catalogueUrl: string | undefined
  let access: CatalogueAccess | null = null

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

      const configuredCacheRoot = expandHome(options.cacheRoot || path.join(server.getDataDirPath(), 'cache'))
      const cacheRoot = path.join(configuredCacheRoot, 'catalogue')
      const tokenFile = expandHome(options.catalogueTokenFile || path.join(server.getDataDirPath(), 'catalogue-token'))
      if (!path.isAbsolute(tokenFile)) throw new Error('Catalogue token file must be absolute')
      const catalogue = new CatalogueClient({
        url: options.catalogueUrl || 'http://127.0.0.1:3000', tokenFile,
        directory: path.join(server.getDataDirPath(), 'catalogue-assets'), cacheRoot,
        maxAssetBytes: options.maxAssetBytes, maxCacheBytes: options.maxCatalogueCacheBytes,
        tokenReader: () => authorizer.token(),
        onUnauthorized: token => authorizer.rejected(token),
      }, message => server.debug(message))
      catalogueUrl = catalogue.endpoint
      let active: GribStore
      let initialScan: Promise<void>
      const authorizer = new CatalogueAccess({
        endpoint: catalogue.endpoint, tokenFile, dataDir: server.getDataDirPath(),
        pluginId: PLUGIN_ID, permissions: 'readonly',
        onChange: () => { if (access && access.status().state !== 'ready') server.setPluginStatus(access.status().message) },
        onReady: () => { initialScan.then(() => { if (store === active) return active.refresh() }).catch(() => server.debug('Catalogue refresh after access approval failed')) },
      })
      access = authorizer

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
        if (access && access.status().state !== 'ready') {
          server.setPluginStatus(access.status().message)
          return
        }
        const parts = summary.sources.map(s => `${s.name}: ${s.slices} slice(s)`)
        if (summary.errors.length > 0) {
          server.setPluginStatus(`${parts.join(', ') || 'no sources'} — ${summary.errors.length} error(s), see debug log`)
        } else {
          server.setPluginStatus(parts.join(', ') || 'no GRIB forecasts in catalogue')
        }
      }

      active = new GribStore(
        cacheRoot,
        (msg: string) => server.debug(msg),
        onScan,
        {
          sourceProvider: signal => catalogue.refresh(signal),
          snapshotFile: path.join(cacheRoot, `.weather-index-${createHash('sha256').update(catalogue.endpoint).digest('hex').slice(0, 16)}.json`),
          maxConcurrentIngests: Math.max(1, Math.floor(options.maxConcurrentIngests ?? 2)),
          sliceCacheSizeMB: options.sliceCacheSizeMB ?? 64,
        }
      )

      store = active
      server.setPluginStatus('Starting up …')
      initialScan = active.start(Math.max(1, options.scanIntervalMinutes ?? 5)).catch((err: unknown) => {
        if (store === active) server.setPluginError(`Startup error: ${err}`)
      })
      access.start()
    },

    stop: async () => {
      const active = store
      store = null
      const previousAccess = access
      access = null
      await previousAccess?.stop()
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
        res.json({ inputMode: 'catalogue', catalogueUrl, catalogueAccess: access?.status(), ...lastSummary })
      })
    },
  }

  return plugin
}
