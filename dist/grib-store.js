"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.GribStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const grib_cache_1 = require("./grib-cache");
const weather_mapper_1 = require("./weather-mapper");
const ingest_manager_1 = require("./ingest-manager");
const GRIB_EXTENSIONS = new Set(['.grb2', '.grib2', '.grb', '.grib']);
class GribStore {
    constructor(sources, log, eccodesImage) {
        this.sources = sources;
        this.log = log;
        // Per-source list of indexed .gribcache entries, sorted ascending by validAt
        this.index = new Map();
        this.scanTimer = null;
        this.eccodesImage = eccodesImage ?? ingest_manager_1.DEFAULT_ECCODES_IMAGE;
    }
    async start(scanIntervalMinutes = 5) {
        await (0, ingest_manager_1.ensureImage)(this.eccodesImage, this.log).catch(err => this.log(`Warning: could not verify eccodes image — ${err}`));
        await this.scanAll();
        this.scanTimer = setInterval(() => this.scanAll().catch(err => this.log(`Scan error: ${err}`)), scanIntervalMinutes * 60000);
    }
    stop() {
        if (this.scanTimer) {
            clearInterval(this.scanTimer);
            this.scanTimer = null;
        }
    }
    // Called by each per-source provider registered in index.ts.
    async getForecastsForSource(sourceName, position, type, options = {}) {
        const entries = this.index.get(sourceName);
        if (!entries || entries.length === 0)
            return [];
        const startDate = options.startDate
            ? new Date(options.startDate + 'T00:00:00Z')
            : new Date();
        let series = entries.filter(e => e.meta.validAt >= startDate);
        if (options.maxCount)
            series = series.slice(0, options.maxCount);
        const results = [];
        for (const entry of series) {
            try {
                const values = await (0, grib_cache_1.queryAtPosition)(entry.filePath, entry.meta, position.latitude, position.longitude);
                if (Object.keys(values).length === 0)
                    continue;
                const slice = { validAt: entry.meta.validAt, values };
                results.push((0, weather_mapper_1.toWeatherData)(slice, type));
            }
            catch (err) {
                this.log(`Query error for ${entry.filePath}: ${err}`);
            }
        }
        return results;
    }
    async scanAll() {
        for (const source of this.sources) {
            await this.scanSource(source).catch(err => this.log(`Scan error for source "${source.name}": ${err}`));
        }
    }
    async scanSource(source) {
        const gribDir = source.directory;
        const cacheDir = source.cacheDirectory ?? gribDir;
        // List GRIB files
        let gribFiles;
        try {
            gribFiles = fs.readdirSync(gribDir)
                .filter(f => GRIB_EXTENSIONS.has(path.extname(f).toLowerCase()))
                .map(f => path.join(gribDir, f));
        }
        catch {
            this.log(`Cannot read directory for source "${source.name}": ${gribDir}`);
            return;
        }
        // Trigger ingest for any GRIB file that doesn't have a .gribcache yet
        const ingestPromises = gribFiles.map(gribPath => (0, ingest_manager_1.ingestGrib)(gribPath, cacheDir, this.eccodesImage, this.log).catch(err => this.log(`Ingest failed for ${path.basename(gribPath)}: ${err}`)));
        await Promise.all(ingestPromises);
        // Re-read cache directory and build index
        let cacheFiles;
        try {
            cacheFiles = fs.readdirSync(cacheDir)
                .filter(f => f.endsWith('.gribcache'))
                .map(f => path.join(cacheDir, f));
        }
        catch {
            this.log(`Cannot read cache directory for source "${source.name}": ${cacheDir}`);
            return;
        }
        const entries = [];
        for (const filePath of cacheFiles) {
            try {
                const meta = await (0, grib_cache_1.readCacheHeader)(filePath);
                entries.push({ filePath, meta });
            }
            catch (err) {
                this.log(`Cannot read cache header ${path.basename(filePath)}: ${err}`);
            }
        }
        // Sort ascending by validity time
        entries.sort((a, b) => a.meta.validAt.getTime() - b.meta.validAt.getTime());
        this.index.set(source.name, entries);
        this.log(`Source "${source.name}": ${entries.length} cache file(s) indexed`);
    }
}
exports.GribStore = GribStore;
