export interface SourceConfig {
    name: string;
    label?: string;
    directory: string;
    model: string;
    cacheDirectory?: string;
}
export interface PluginSettings {
    sources: SourceConfig[];
    scanIntervalMinutes?: number;
    eccodesImage?: string;
}
export interface GridMeta {
    latFirst: number;
    lonFirst: number;
    dLat: number;
    dLon: number;
    nLat: number;
    nLon: number;
    jScansPositively: boolean;
}
export interface CacheFileMeta {
    validAt: Date;
    grid: GridMeta;
    vars: string[];
    nVars: number;
    dataStart: number;
}
export interface CacheEntry {
    filePath: string;
    meta: CacheFileMeta;
}
export interface TimeSlice {
    validAt: Date;
    values: Record<string, number>;
}
