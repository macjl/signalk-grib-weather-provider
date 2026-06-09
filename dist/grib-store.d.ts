import { Position, WeatherData, WeatherForecastType, WeatherReqParams } from '@signalk/server-api';
import { SourceConfig } from './types';
export declare class GribStore {
    private sources;
    private log;
    private index;
    private scanTimer;
    private eccodesImage;
    constructor(sources: SourceConfig[], log: (msg: string) => void, eccodesImage?: string);
    start(scanIntervalMinutes?: number): Promise<void>;
    stop(): void;
    getForecastsForSource(sourceName: string, position: Position, type: WeatherForecastType, options?: WeatherReqParams): Promise<WeatherData[]>;
    private scanAll;
    private scanSource;
}
