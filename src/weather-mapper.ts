import { TimeSlice } from './types'
import { WeatherData, WeatherForecastType } from '@signalk/server-api'

// U/V (m/s) → speed (m/s) + meteorological FROM direction (rad from true N)
function uvToSpeedDir(u: number, v: number): { speed: number; direction: number } {
  return {
    speed:     Math.sqrt(u * u + v * v),
    direction: (Math.atan2(-u, -v) + 2 * Math.PI) % (2 * Math.PI),
  }
}

// Map a TimeSlice (field values already in SI units) to a WeatherData object.
export function toWeatherData(slice: TimeSlice, type: WeatherForecastType): WeatherData {
  const v = slice.values
  const data: WeatherData = { date: slice.validAt.toISOString(), type }

  if (v['windU'] !== undefined && v['windV'] !== undefined) {
    const { speed, direction } = uvToSpeedDir(v['windU'], v['windV'])
    data.wind = {
      speedTrue:     speed,
      directionTrue: direction,
      ...(v['gust'] !== undefined ? { gust: v['gust'] } : {}),
    }
  }

  const outside: WeatherData['outside'] = {}
  if (v['temp2m']     !== undefined) outside.temperature         = v['temp2m']
  if (v['pressure']   !== undefined) outside.pressure            = v['pressure']
  if (v['humidity']   !== undefined) outside.relativeHumidity    = v['humidity']
  if (v['cloudCover'] !== undefined) outside.cloudCover          = v['cloudCover']
  if (v['precip']     !== undefined) outside.precipitationVolume = v['precip']
  if (Object.keys(outside).length > 0) data.outside = outside

  return data
}
