import { CacheFileMeta } from './types';
export declare function readCacheHeader(filePath: string): Promise<CacheFileMeta>;
export declare function queryAtPosition(filePath: string, meta: CacheFileMeta, lat: number, lon: number): Promise<Record<string, number>>;
