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
exports.readCacheHeader = readCacheHeader;
exports.queryAtPosition = queryAtPosition;
const fs = __importStar(require("fs"));
const MAGIC = Buffer.from('GRBC');
const VERSION = 1;
// Parse the binary header of a .gribcache file. Does not load data.
async function readCacheHeader(filePath) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const prefix = Buffer.allocUnsafe(9); // magic(4) + version(1) + jsonLen(4)
        await fh.read(prefix, 0, 9, 0);
        if (!prefix.subarray(0, 4).equals(MAGIC)) {
            throw new Error(`Not a gribcache file: ${filePath}`);
        }
        if (prefix[4] !== VERSION) {
            throw new Error(`Unsupported gribcache version ${prefix[4]}: ${filePath}`);
        }
        const jsonLen = prefix.readUInt32BE(5);
        const jsonBuf = Buffer.allocUnsafe(jsonLen);
        await fh.read(jsonBuf, 0, jsonLen, 9);
        const m = JSON.parse(jsonBuf.toString('utf-8'));
        const grid = {
            latFirst: m.latFirst,
            lonFirst: m.lonFirst,
            dLat: m.dLat,
            dLon: m.dLon,
            nLat: m.nLat,
            nLon: m.nLon,
            jScansPositively: m.jScansPositively,
        };
        return {
            validAt: new Date(m.validAt),
            grid,
            vars: m.vars,
            nVars: m.vars.length,
            dataStart: 9 + jsonLen,
        };
    }
    finally {
        await fh.close();
    }
}
// Read values for all variables at grid indices (j, i) using an already-open file handle.
// Clamped to grid bounds.
async function readPoint(fh, meta, j, i) {
    const { nLat, nLon } = meta.grid;
    const jc = Math.max(0, Math.min(nLat - 1, j));
    const ic = Math.max(0, Math.min(nLon - 1, i));
    const byteOffset = meta.dataStart + (jc * nLon + ic) * meta.nVars * 4;
    const buf = Buffer.allocUnsafe(meta.nVars * 4);
    await fh.read(buf, 0, meta.nVars * 4, byteOffset);
    const floats = new Float32Array(buf.buffer, buf.byteOffset, meta.nVars);
    const result = {};
    for (let k = 0; k < meta.nVars; k++) {
        const v = floats[k];
        if (!isNaN(v))
            result[meta.vars[k]] = v;
    }
    return result;
}
// Compute the 4 surrounding grid cell corner indices and coordinates for (lat, lon).
// Returns { jSouth, jNorth, iWest, iEast, latSouth, latNorth, lonWest, lonEast }
function cornerIndices(lat, lon, meta) {
    const { latFirst, lonFirst, dLat, dLon, nLat, nLon, jScansPositively } = meta.grid;
    let jSouth, jNorth, latSouth, latNorth;
    if (!jScansPositively) {
        // N→S grid (GFS): j=0 is northernmost, lat decreases with j
        const jN = Math.floor((latFirst - lat) / dLat);
        jNorth = Math.max(0, Math.min(nLat - 2, jN));
        jSouth = jNorth + 1;
        latNorth = latFirst - jNorth * dLat;
        latSouth = latFirst - jSouth * dLat;
    }
    else {
        // S→N grid: j=0 is southernmost
        const jS = Math.floor((lat - latFirst) / dLat);
        jSouth = Math.max(0, Math.min(nLat - 2, jS));
        jNorth = jSouth + 1;
        latSouth = latFirst + jSouth * dLat;
        latNorth = latFirst + jNorth * dLat;
    }
    // Normalise lon to [lonFirst, lonFirst+360)
    let normLon = lon;
    while (normLon < lonFirst)
        normLon += 360;
    while (normLon >= lonFirst + 360)
        normLon -= 360;
    const iW = Math.floor((normLon - lonFirst) / dLon);
    const iWest = Math.max(0, Math.min(nLon - 2, iW));
    const iEast = iWest + 1;
    const lonWest = lonFirst + iWest * dLon;
    const lonEast = lonFirst + iEast * dLon;
    return { jSouth, jNorth, iWest, iEast, latSouth, latNorth, lonWest, lonEast, normLon };
}
// Read 4 surrounding grid points and return bilinearly interpolated values.
// Opens the file once, issues 4 parallel reads, closes.
async function queryAtPosition(filePath, meta, lat, lon) {
    const c = cornerIndices(lat, lon, meta);
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const [sw, se, nw, ne] = await Promise.all([
            readPoint(fh, meta, c.jSouth, c.iWest),
            readPoint(fh, meta, c.jSouth, c.iEast),
            readPoint(fh, meta, c.jNorth, c.iWest),
            readPoint(fh, meta, c.jNorth, c.iEast),
        ]);
        const dLat = c.latNorth - c.latSouth;
        const dLon = c.lonEast - c.lonWest;
        const dy = dLat > 0 ? (lat - c.latSouth) / dLat : 0;
        const dx = dLon > 0 ? (c.normLon - c.lonWest) / dLon : 0;
        const allKeys = new Set([
            ...Object.keys(sw), ...Object.keys(se),
            ...Object.keys(nw), ...Object.keys(ne),
        ]);
        const result = {};
        for (const key of allKeys) {
            const vSW = sw[key], vSE = se[key], vNW = nw[key], vNE = ne[key];
            if (vSW !== undefined && vSE !== undefined && vNW !== undefined && vNE !== undefined) {
                result[key] =
                    (1 - dx) * (1 - dy) * vSW +
                        dx * (1 - dy) * vSE +
                        (1 - dx) * dy * vNW +
                        dx * dy * vNE;
            }
            else {
                const fallback = vSW ?? vSE ?? vNW ?? vNE;
                if (fallback !== undefined)
                    result[key] = fallback;
            }
        }
        return result;
    }
    finally {
        await fh.close();
    }
}
