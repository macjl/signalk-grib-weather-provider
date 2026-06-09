#!/usr/bin/env python3
"""
Convert a GRIB2 file to .gribcache binary format.

Usage: grib2cache.py <input.grb2> <output_dir/>

Output: <output_dir>/<basename>.gribcache

.gribcache format
  [4]  magic: b'GRBC'
  [1]  version: 0x01
  [4]  json_length: uint32 big-endian
  [N]  json header (UTF-8):
         { validAt, latFirst, lonFirst, dLat, dLon, nLat, nLon,
           jScansPositively, vars: [fieldName, ...] }
  [*]  float32 little-endian, interleaved point-major:
         for j in 0..nLat-1, i in 0..nLon-1:
           for each var: float32 (NaN if missing)

Grid row j=0 is at latitude latFirst (northernmost if jScansPositively=false).
"""
import sys
import os
import json
import struct
import eccodes
import numpy as np

PARAM_DEFS = [
    # (shortName, typeOfLevel, level, field, scale)
    # First matching definition per field wins.
    ('2t',    'heightAboveGround', 2,  'temp2m',    1.0),
    ('prmsl', 'meanSea',           0,  'pressure',  1.0),
    ('2r',    'heightAboveGround', 2,  'humidity',  0.01),
    ('r',     'heightAboveGround', 2,  'humidity',  0.01),
    ('10u',   'heightAboveGround', 10, 'windU',     1.0),
    ('u',     'heightAboveGround', 10, 'windU',     1.0),
    ('10v',   'heightAboveGround', 10, 'windV',     1.0),
    ('v',     'heightAboveGround', 10, 'windV',     1.0),
    ('gust',  'surface',           0,  'gust',      1.0),
    ('gust',  'heightAboveGround', 10, 'gust',      1.0),
    ('tp',    'surface',           0,  'precip',    0.001),
    ('tcc',   'entireAtmosphere',  0,  'cloudCover', 0.01),
]

# Output field order (canonical)
FIELD_ORDER = ['temp2m', 'pressure', 'humidity', 'windU', 'windV', 'gust', 'precip', 'cloudCover']

def build_lookup():
    lookup = {}
    for sn, tol, lev, field, scale in PARAM_DEFS:
        k = (sn, tol, lev)
        if k not in lookup:
            lookup[k] = (field, scale)
    return lookup

LOOKUP = build_lookup()


def transform(grb_path: str) -> bytes:
    grid_meta = None
    # field_data[field] = (scale, np.ndarray float64) — first message per field wins
    field_data = {}

    with open(grb_path, 'rb') as f:
        while True:
            handle = eccodes.codes_grib_new_from_file(f)
            if handle is None:
                break
            try:
                sn  = eccodes.codes_get(handle, 'shortName')
                tol = eccodes.codes_get(handle, 'typeOfLevel')
                lev = eccodes.codes_get(handle, 'level')
                key = (sn, tol, lev)
                if key not in LOOKUP:
                    continue

                field, scale = LOOKUP[key]
                if field in field_data:
                    continue  # already have a higher-priority source

                if grid_meta is None:
                    grid_meta = {
                        'latFirst': eccodes.codes_get(handle, 'latitudeOfFirstGridPointInDegrees'),
                        'lonFirst': eccodes.codes_get(handle, 'longitudeOfFirstGridPointInDegrees'),
                        'dLat':     eccodes.codes_get(handle, 'jDirectionIncrementInDegrees'),
                        'dLon':     eccodes.codes_get(handle, 'iDirectionIncrementInDegrees'),
                        'nLat':     eccodes.codes_get(handle, 'Nj'),
                        'nLon':     eccodes.codes_get(handle, 'Ni'),
                        'jScansPositively': bool(eccodes.codes_get(handle, 'jScansPositively')),
                    }
                    # Capture validity time from the first recognized message
                    vdate = eccodes.codes_get(handle, 'validityDate')
                    vtime = eccodes.codes_get(handle, 'validityTime')
                    vtime_str = str(vtime).zfill(4)
                    vdate_str = str(vdate)
                    grid_meta['validAt'] = (
                        f"{vdate_str[:4]}-{vdate_str[4:6]}-{vdate_str[6:8]}"
                        f"T{vtime_str[:2]}:{vtime_str[2:]}:00Z"
                    )

                values = eccodes.codes_get_values(handle)  # ndarray float64, shape (nLat*nLon,)
                field_data[field] = (scale, values)

            finally:
                eccodes.codes_release(handle)

    if grid_meta is None or not field_data:
        raise RuntimeError('No recognized variables found in GRIB file')

    fields_present = [f for f in FIELD_ORDER if f in field_data]
    if not fields_present:
        raise RuntimeError('No recognized fields could be extracted')

    n_vars = len(fields_present)
    n_lat  = grid_meta['nLat']
    n_lon  = grid_meta['nLon']

    meta = {k: v for k, v in grid_meta.items()}
    meta['vars'] = fields_present
    meta_json = json.dumps(meta).encode('utf-8')

    # Apply scale factors and stack into (nPoints, nVars) float32
    arrays = []
    for field in fields_present:
        scale, values = field_data[field]
        arrays.append((values * scale).astype(np.float32))

    stacked = np.stack(arrays, axis=1)  # shape: (nLat*nLon, nVars)

    import io
    buf = io.BytesIO()
    buf.write(b'GRBC')
    buf.write(struct.pack('B', 1))
    buf.write(struct.pack('>I', len(meta_json)))
    buf.write(meta_json)
    buf.write(stacked.tobytes())  # little-endian on x86/ARM64
    return buf.getvalue()


def main():
    if len(sys.argv) != 3:
        print(f'Usage: {sys.argv[0]} <input.grb2> <output_dir/>', file=sys.stderr)
        sys.exit(1)

    grb_path = sys.argv[1]
    out_dir  = sys.argv[2].rstrip('/')

    if not os.path.isfile(grb_path):
        print(f'Input file not found: {grb_path}', file=sys.stderr)
        sys.exit(1)

    os.makedirs(out_dir, exist_ok=True)

    basename = os.path.splitext(os.path.basename(grb_path))[0]
    out_path = os.path.join(out_dir, basename + '.gribcache')

    try:
        data = transform(grb_path)
        with open(out_path, 'wb') as out:
            out.write(data)
        print(f'Written {len(data):,} bytes → {out_path}', flush=True)
    except Exception as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
