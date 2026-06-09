"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const grib_store_1 = require("./grib-store");
const ingest_manager_1 = require("./ingest-manager");
const PLUGIN_ID = 'signalk-grib-weather-provider';
const CONFIG_SCHEMA = {
    type: 'object',
    properties: {
        sources: {
            type: 'array',
            title: 'GRIB Sources',
            description: 'Each source registers as a separate weather provider in SignalK. ' +
                'The name must be unique and URL-safe (letters, digits, hyphens).',
            items: {
                type: 'object',
                required: ['name', 'directory', 'model'],
                properties: {
                    name: {
                        type: 'string',
                        title: 'Source ID',
                        description: 'Unique identifier — becomes the provider ID suffix ' +
                            '(e.g. "arome" → provider "signalk-grib-weather-provider:arome")',
                    },
                    label: {
                        type: 'string',
                        title: 'Display name',
                        description: 'Human-readable name shown in the source selector (optional, defaults to name)',
                    },
                    directory: {
                        type: 'string',
                        title: 'GRIB directory',
                        description: 'Absolute path to the directory containing GRIB2 files',
                    },
                    model: {
                        type: 'string',
                        title: 'Model',
                        enum: ['gfs', 'arpege', 'arome', 'icon'],
                        default: 'gfs',
                    },
                    cacheDirectory: {
                        type: 'string',
                        title: 'Cache directory (optional)',
                        description: 'Where .gribcache files are stored. Defaults to the GRIB directory.',
                    },
                },
            },
        },
        scanIntervalMinutes: {
            type: 'number',
            title: 'Scan interval (minutes)',
            description: 'How often to check for new GRIB files',
            default: 5,
            minimum: 1,
        },
        eccodesImage: {
            type: 'string',
            title: 'Eccodes container image',
            description: `Docker image used for GRIB→cache conversion. Default: ${ingest_manager_1.DEFAULT_ECCODES_IMAGE}`,
            default: ingest_manager_1.DEFAULT_ECCODES_IMAGE,
        },
    },
};
module.exports = (server) => {
    let store = null;
    let registeredIds = [];
    const plugin = {
        id: PLUGIN_ID,
        name: 'GRIB Weather Provider',
        schema: () => CONFIG_SCHEMA,
        start: (options) => {
            // Access the weather API directly to support custom provider IDs per source.
            const weatherApi = server.weatherApi;
            if (!weatherApi?.register) {
                server.setPluginError('Weather API not available — upgrade SignalK server to >=2.x');
                return;
            }
            const containers = globalThis.__signalk_containerManager;
            if (!containers) {
                server.setPluginError('signalk-container plugin is required but not installed or not running');
                return;
            }
            const sources = options.sources ?? [];
            if (sources.length === 0) {
                server.setPluginError('No sources configured');
                return;
            }
            store = new grib_store_1.GribStore(sources, (msg) => server.debug(msg), options.eccodesImage);
            containers.whenReady().then(() => {
                if (!containers.getRuntime()) {
                    server.setPluginError('No container runtime detected (Docker/Podman not available)');
                    return;
                }
                store.start(options.scanIntervalMinutes ?? 5).catch((err) => {
                    server.setPluginError(`Startup error: ${err}`);
                });
            });
            // Register each source as an independent weather provider.
            // Provider ID: "signalk-grib-weather-provider:<source.name>"
            registeredIds = [];
            for (const source of sources) {
                const providerId = `${PLUGIN_ID}:${source.name}`;
                const displayName = source.label ?? source.name;
                const sourceName = source.name; // captured for closure
                weatherApi.register(providerId, {
                    name: displayName,
                    methods: {
                        getObservations: async () => [],
                        getForecasts: (position, type, opts) => store.getForecastsForSource(sourceName, position, type, opts ?? {}),
                        getWarnings: async () => [],
                    },
                });
                registeredIds.push(providerId);
                server.debug(`Registered weather provider: ${providerId} ("${displayName}")`);
            }
            server.setPluginStatus(`Running — ${sources.length} source(s): ${sources.map(s => s.label ?? s.name).join(', ')}`);
        },
        stop: () => {
            const weatherApi = server.weatherApi;
            for (const id of registeredIds) {
                weatherApi?.unRegister(id);
                server.debug(`Unregistered weather provider: ${id}`);
            }
            registeredIds = [];
            store?.stop();
            store = null;
        },
    };
    return plugin;
};
