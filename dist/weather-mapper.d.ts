import { TimeSlice } from './types';
import { WeatherData, WeatherForecastType } from '@signalk/server-api';
export declare function toWeatherData(slice: TimeSlice, type: WeatherForecastType): WeatherData;
