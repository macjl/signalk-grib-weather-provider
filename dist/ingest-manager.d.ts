export declare function cachePathFor(gribPath: string, cacheDir: string): string;
export declare function ensureImage(image: string, log: (m: string) => void): Promise<void>;
export declare function ingestGrib(gribPath: string, cacheDir: string, image: string, log: (m: string) => void): Promise<string | null>;
export declare const DEFAULT_ECCODES_IMAGE = "signalk-grib-eccodes:latest";
