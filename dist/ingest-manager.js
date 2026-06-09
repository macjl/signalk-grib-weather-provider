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
exports.DEFAULT_ECCODES_IMAGE = void 0;
exports.cachePathFor = cachePathFor;
exports.ensureImage = ensureImage;
exports.ingestGrib = ingestGrib;
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const PLUGIN_ID = 'signalk-grib-weather-provider';
const DEFAULT_IMAGE = 'signalk-grib-eccodes:latest';
// Tracks GRIB files currently being ingested to prevent duplicate jobs.
const pending = new Set();
function containerManager() {
    return globalThis.__signalk_containerManager ?? null;
}
// Returns the path of the .gribcache file produced from a GRIB file, or null if not yet ingested.
function cachePathFor(gribPath, cacheDir) {
    const basename = path.basename(gribPath, path.extname(gribPath));
    return path.join(cacheDir, basename + '.gribcache');
}
// Ensure the eccodes container image is available. Must be called after containers.whenReady().
async function ensureImage(image, log) {
    const containers = containerManager();
    if (!containers)
        throw new Error('signalk-container not available');
    const exists = await containers.imageExists(image);
    if (!exists) {
        log(`Pulling eccodes image ${image} …`);
        await containers.pullImage(image, (line) => log(`  pull: ${line}`));
        log(`Image ${image} ready`);
    }
}
// Ingest a GRIB file into a .gribcache file if not already done.
// Returns the .gribcache path on success, null if already in progress.
async function ingestGrib(gribPath, cacheDir, image, log) {
    const cachePath = cachePathFor(gribPath, cacheDir);
    // Already ingested?
    if (fs.existsSync(cachePath))
        return cachePath;
    // Already in progress?
    if (pending.has(gribPath))
        return null;
    const containers = containerManager();
    if (!containers)
        throw new Error('signalk-container not available');
    pending.add(gribPath);
    try {
        log(`Ingesting ${path.basename(gribPath)} …`);
        // Resolve GRIB directory for container volume mounting
        const gribDir = path.dirname(gribPath);
        const rGrib = await containers.resolveHostPath(gribDir);
        if (!rGrib) {
            throw new Error(`GRIB directory "${gribDir}" is not reachable from the container runtime. ` +
                `Move it inside the SignalK data directory or bind-mount it into the SignalK container.`);
        }
        // Resolve cache directory (may be the same volume as grib dir)
        await fs.promises.mkdir(cacheDir, { recursive: true });
        const rCache = await containers.resolveHostPath(cacheDir);
        if (!rCache) {
            throw new Error(`Cache directory "${cacheDir}" is not reachable from the container runtime.`);
        }
        const gribBasename = path.basename(gribPath);
        const inGribPath = rGrib.subPath ? `${rGrib.subPath}/${gribBasename}` : gribBasename;
        const outDir = rCache.subPath ? `/${rCache.subPath}` : '/';
        // runJob: read GRIB → write .gribcache
        // Use separate container mounts even if they resolve to the same host source.
        const volumes = {
            '/grib-in': rGrib.source,
        };
        const outputVolumes = {
            '/cache-out': rCache.source,
        };
        const result = await containers.runJob({
            image,
            command: [
                'python3', '/app/grib2cache.py',
                `/grib-in/${inGribPath}`,
                `/cache-out${outDir}`,
            ],
            inputs: volumes,
            outputs: outputVolumes,
            timeout: 180,
            ownerPluginId: PLUGIN_ID,
            onProgress: (line) => log(`  eccodes: ${line}`),
        });
        if (result.status !== 'completed' || result.exitCode !== 0) {
            throw new Error(`Ingest job failed (exit ${result.exitCode}): ${result.log?.slice(-500)}`);
        }
        if (!fs.existsSync(cachePath)) {
            throw new Error(`Job completed but ${cachePath} was not created`);
        }
        log(`Ingest complete: ${path.basename(cachePath)}`);
        return cachePath;
    }
    finally {
        pending.delete(gribPath);
    }
}
exports.DEFAULT_ECCODES_IMAGE = DEFAULT_IMAGE;
