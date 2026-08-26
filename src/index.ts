import * as os from 'os'
import * as path from 'path'
import { Plugin, ServerAPI } from '@signalk/server-api'
import { WeatherProviderRegistry } from '@signalk/server-api'
import { GribStore, ScanSummary } from './grib-store'
import { PluginSettings } from './types'

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
    rootDirectory: {
      type: 'string',
      title: 'GRIB root directory',
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
      description: 'How often to discover sources and check for new GRIB files',
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
  },
})

module.exports = (server: PluginApp): Plugin => {
  let store: GribStore | null = null
  let registered = new Set<string>()

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

      const rootDirectory = expandHome(options.rootDirectory || DEFAULT_ROOT)
      const cacheRoot = expandHome(options.cacheRoot || path.join(server.getDataDirPath(), 'cache'))

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
                  store!.getForecastsForSource(name, position, type, opts ?? {}),
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
        syncProviders(summary.sources.map(s => s.name))
        const parts = summary.sources.map(s => `${s.name}: ${s.slices} slice(s)`)
        if (summary.errors.length > 0) {
          server.setPluginStatus(`${parts.join(', ') || 'no sources'} — ${summary.errors.length} error(s), see debug log`)
        } else {
          server.setPluginStatus(parts.join(', ') || `no sources found in ${rootDirectory}`)
        }
      }

      store = new GribStore(
        rootDirectory,
        cacheRoot,
        (msg: string) => server.debug(msg),
        onScan,
        options.maxConcurrentIngests ?? 2
      )

      server.setPluginStatus('Starting up …')
      store.start(options.scanIntervalMinutes ?? 5).catch((err: unknown) => {
        server.setPluginError(`Startup error: ${err}`)
      })
    },

    stop: () => {
      const weatherApi = (server as any).weatherApi
      for (const name of registered) {
        weatherApi?.unRegister(`${PLUGIN_ID}:${name}`)
      }
      registered.clear()
      store?.stop()
      store = null
    },
  }

  return plugin
}
