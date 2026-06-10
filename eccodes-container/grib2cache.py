#!/usr/bin/env python3
"""
Convert a GRIB2 file to .gribcache binary format — one file per validity time.

Usage: grib2cache.py <input.grb2> <output_dir/>

Output: <output_dir>/<basename>.t<YYYYMMDDHHMM>.gribcache  (one per validity time)

.gribcache format (version 2)
  [4]  magic: b'GRBC'
  [1]  version: 0x02
  [4]  json_length: uint32 big-endian
  [N]  json header (UTF-8):
         { validAt, refTime, latFirst, lonFirst, dLat, dLon, nLat, nLon,
           jScansPositively, vars: [fieldName, ...],
           precipAccum: [startStep, endStep] | null }
  [*]  float32 little-endian, interleaved point-major:
         for j in 0..nLat-1, i in 0..nLon-1:
           for each var: float32 (NaN if missing)

Grid row j=0 is at latitude latFirst (northernmost if jScansPositively=false).
refTime is the model run reference time — used to deduplicate overlapping runs.
precipAccum describes the accumulation window of the 'precip' field in forecast
hours ([0, 6] = cumulative since run start; [6, 12] = 6-hour bucket).
"""
import sys
import os
import json
import struct
import eccodes
import numpy as np

PARAM_DEFS = [
    # (shortName, typeOfLevel, level, field, scale)
    # First matching definition per (validity time, field) wins.
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
    ('max_i10fg', 'heightAboveGround', 10, 'gust',  1.0),   # AROME / ICON
    ('tp',    'surface',           0,  'precip',    0.001),
    ('tcc',   'entireAtmosphere',  0,  'cloudCover', 0.01),
    ('tcc',   'atmosphere',        0,  'cloudCover', 0.01),  # GFS via NOMADS filter
    ('CLCT',  'surface',           0,  'cloudCover', 0.01),  # ICON
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


def transform(grb_path: str):
    """Parse all messages, grouped by validity time.

    Returns (grid_meta, ref_time_iso, slices) where
      slices[validAt_iso] = {
        'fields': {field: (scale, ndarray)},
        'precipAccum': (startStep, endStep) | None
      }
    """
    grid_meta = None
    ref_time = None
    slices = {}

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
                else:
                    # All slices must share the same grid — skip mismatching messages
                    if (eccodes.codes_get(handle, 'Nj') != grid_meta['nLat'] or
                            eccodes.codes_get(handle, 'Ni') != grid_meta['nLon']):
                        print(f'Skipping {sn}/{tol}/{lev}: grid mismatch', file=sys.stderr)
                        continue

                if ref_time is None:
                    rdate = str(eccodes.codes_get(handle, 'dataDate'))
                    rtime = str(eccodes.codes_get(handle, 'dataTime')).zfill(4)
                    ref_time = (
                        f"{rdate[:4]}-{rdate[4:6]}-{rdate[6:8]}"
                        f"T{rtime[:2]}:{rtime[2:]}:00Z"
                    )

                vdate = str(eccodes.codes_get(handle, 'validityDate'))
                vtime = str(eccodes.codes_get(handle, 'validityTime')).zfill(4)
                valid_at = (
                    f"{vdate[:4]}-{vdate[4:6]}-{vdate[6:8]}"
                    f"T{vtime[:2]}:{vtime[2:]}:00Z"
                )

                sl = slices.setdefault(valid_at, {'fields': {}, 'precipAccum': None})
                if field in sl['fields']:
                    continue  # already have a higher-priority source for this slice

                if field == 'precip':
                    try:
                        ss = int(eccodes.codes_get(handle, 'startStep'))
                        es = int(eccodes.codes_get(handle, 'endStep'))
                        sl['precipAccum'] = (ss, es)
                    except Exception:
                        pass

                values = eccodes.codes_get_values(handle)  # ndarray float64
                sl['fields'][field] = (scale, values)

            finally:
                eccodes.codes_release(handle)

    if grid_meta is None or not slices:
        raise RuntimeError('No recognized variables found in GRIB file')

    return grid_meta, ref_time, slices


def encode_slice(grid_meta, ref_time, valid_at, sl) -> bytes:
    fields_present = [f for f in FIELD_ORDER if f in sl['fields']]
    if not fields_present:
        raise RuntimeError('No recognized fields in slice')

    meta = dict(grid_meta)
    meta['validAt'] = valid_at
    meta['refTime'] = ref_time
    meta['vars'] = fields_present
    meta['precipAccum'] = list(sl['precipAccum']) if sl['precipAccum'] else None
    meta_json = json.dumps(meta).encode('utf-8')

    arrays = []
    for field in fields_present:
        scale, values = sl['fields'][field]
        arrays.append((values * scale).astype(np.float32))
    stacked = np.stack(arrays, axis=1)  # shape: (nLat*nLon, nVars)

    import io
    buf = io.BytesIO()
    buf.write(b'GRBC')
    buf.write(struct.pack('B', 2))
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

    try:
        grid_meta, ref_time, slices = transform(grb_path)
        written = 0
        for valid_at in sorted(slices.keys()):
            data = encode_slice(grid_meta, ref_time, valid_at, slices[valid_at])
            stamp = valid_at.replace('-', '').replace(':', '').replace('T', '')[:12]
            out_path = os.path.join(out_dir, f'{basename}.t{stamp}.gribcache')
            with open(out_path, 'wb') as out:
                out.write(data)
            print(f'Written {len(data):,} bytes → {out_path}', flush=True)
            written += 1
        if written == 0:
            raise RuntimeError('No slices written')
    except Exception as exc:
        print(f'Error: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
