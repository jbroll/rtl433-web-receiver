// Captured from api.weather.gov for 40.0150,-105.2705 (Boulder, Colorado).
// Trimmed to the fields the parsers read. Regenerate by hand if the shape changes.

export const POINTS = {
  "properties": {
    "forecast": "https://api.weather.gov/gridpoints/BOU/54,75/forecast",
    "forecastHourly": "https://api.weather.gov/gridpoints/BOU/54,75/forecast/hourly",
    "observationStations": "https://api.weather.gov/gridpoints/BOU/54,75/stations",
    "timeZone": "America/Denver",
    "relativeLocation": {
      "properties": {
        "city": "Boulder",
        "state": "CO"
      }
    }
  }
}

export const FORECAST = {
  "properties": {
    "periods": [
      {
        "number": 1,
        "name": "Today",
        "startTime": "2026-08-18T06:00:00-06:00",
        "endTime": "2026-08-18T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 91,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 27
        },
        "windSpeed": "3 to 8 mph",
        "windDirection": "ENE",
        "icon": "https://api.weather.gov/icons/land/day/bkn/tsra_hi,30?size=medium",
        "shortForecast": "Partly Sunny then Chance Showers And Thunderstorms",
        "detailedForecast": "A chance of showers and thunderstorms after noon. Partly sunny. High near 91, with temperatures falling to around 86 in the afternoon. East northeast wind 3 to 8 mph, with gusts as high as 16 mph. Chance of precipitation is 30%."
      },
      {
        "number": 2,
        "name": "Tonight",
        "startTime": "2026-08-18T18:00:00-06:00",
        "endTime": "2026-08-19T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 60,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 39
        },
        "windSpeed": "2 to 6 mph",
        "windDirection": "WNW",
        "icon": "https://api.weather.gov/icons/land/night/tsra_hi,40/tsra_hi,20?size=medium",
        "shortForecast": "Chance Showers And Thunderstorms",
        "detailedForecast": "A chance of showers and thunderstorms before 9pm, then a chance of showers and thunderstorms between 9pm and 3am. Mostly cloudy. Low around 60, with temperatures rising to around 62 overnight. West northwest wind 2 to 6 mph. Chance of precipitation is 40%. New rainfall amounts less than a tenth of an inch possible."
      },
      {
        "number": 3,
        "name": "Wednesday",
        "startTime": "2026-08-19T06:00:00-06:00",
        "endTime": "2026-08-19T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 88,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 28
        },
        "windSpeed": "2 to 6 mph",
        "windDirection": "ENE",
        "icon": "https://api.weather.gov/icons/land/day/sct/tsra_hi,30?size=medium",
        "shortForecast": "Mostly Sunny then Chance Showers And Thunderstorms",
        "detailedForecast": "A chance of showers and thunderstorms between noon and 5pm. Mostly sunny. High near 88, with temperatures falling to around 85 in the afternoon. East northeast wind 2 to 6 mph. Chance of precipitation is 30%."
      },
      {
        "number": 4,
        "name": "Wednesday Night",
        "startTime": "2026-08-19T18:00:00-06:00",
        "endTime": "2026-08-20T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 61,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 6
        },
        "windSpeed": "2 to 6 mph",
        "windDirection": "WNW",
        "icon": "https://api.weather.gov/icons/land/night/sct?size=medium",
        "shortForecast": "Partly Cloudy",
        "detailedForecast": "Partly cloudy, with a low around 61. West northwest wind 2 to 6 mph."
      },
      {
        "number": 5,
        "name": "Thursday",
        "startTime": "2026-08-20T06:00:00-06:00",
        "endTime": "2026-08-20T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 93,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 7
        },
        "windSpeed": "0 to 6 mph",
        "windDirection": "NNW",
        "icon": "https://api.weather.gov/icons/land/day/few?size=medium",
        "shortForecast": "Sunny",
        "detailedForecast": "Sunny, with a high near 93. North northwest wind 0 to 6 mph."
      },
      {
        "number": 6,
        "name": "Thursday Night",
        "startTime": "2026-08-20T18:00:00-06:00",
        "endTime": "2026-08-21T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 63,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 8
        },
        "windSpeed": "5 mph",
        "windDirection": "SW",
        "icon": "https://api.weather.gov/icons/land/night/sct?size=medium",
        "shortForecast": "Partly Cloudy",
        "detailedForecast": "Partly cloudy, with a low around 63."
      },
      {
        "number": 7,
        "name": "Friday",
        "startTime": "2026-08-21T06:00:00-06:00",
        "endTime": "2026-08-21T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 94,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 16
        },
        "windSpeed": "1 to 6 mph",
        "windDirection": "NNE",
        "icon": "https://api.weather.gov/icons/land/day/sct/tsra_hi,20?size=medium",
        "shortForecast": "Mostly Sunny then Slight Chance Showers And Thunderstorms",
        "detailedForecast": "A slight chance of showers and thunderstorms after noon. Mostly sunny, with a high near 94."
      },
      {
        "number": 8,
        "name": "Friday Night",
        "startTime": "2026-08-21T18:00:00-06:00",
        "endTime": "2026-08-22T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 64,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 7
        },
        "windSpeed": "3 mph",
        "windDirection": "WNW",
        "icon": "https://api.weather.gov/icons/land/night/sct?size=medium",
        "shortForecast": "Partly Cloudy",
        "detailedForecast": "Partly cloudy, with a low around 64."
      },
      {
        "number": 9,
        "name": "Saturday",
        "startTime": "2026-08-22T06:00:00-06:00",
        "endTime": "2026-08-22T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 92,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 46
        },
        "windSpeed": "1 to 5 mph",
        "windDirection": "SSE",
        "icon": "https://api.weather.gov/icons/land/day/sct/tsra_hi,50?size=medium",
        "shortForecast": "Mostly Sunny then Chance Showers And Thunderstorms",
        "detailedForecast": "A chance of showers and thunderstorms after noon. Mostly sunny, with a high near 92."
      },
      {
        "number": 10,
        "name": "Saturday Night",
        "startTime": "2026-08-22T18:00:00-06:00",
        "endTime": "2026-08-23T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 64,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 27
        },
        "windSpeed": "6 mph",
        "windDirection": "WSW",
        "icon": "https://api.weather.gov/icons/land/night/tsra_hi,30/bkn?size=medium",
        "shortForecast": "Chance Showers And Thunderstorms then Mostly Cloudy",
        "detailedForecast": "A chance of showers and thunderstorms before midnight. Mostly cloudy, with a low around 64."
      },
      {
        "number": 11,
        "name": "Sunday",
        "startTime": "2026-08-23T06:00:00-06:00",
        "endTime": "2026-08-23T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 91,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 75
        },
        "windSpeed": "6 mph",
        "windDirection": "NNW",
        "icon": "https://api.weather.gov/icons/land/day/bkn/tsra_sct,80?size=medium",
        "shortForecast": "Partly Sunny then Showers And Thunderstorms",
        "detailedForecast": "Showers and thunderstorms after noon. Partly sunny, with a high near 91."
      },
      {
        "number": 12,
        "name": "Sunday Night",
        "startTime": "2026-08-23T18:00:00-06:00",
        "endTime": "2026-08-24T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 61,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 49
        },
        "windSpeed": "3 mph",
        "windDirection": "W",
        "icon": "https://api.weather.gov/icons/land/night/tsra_hi,50/bkn?size=medium",
        "shortForecast": "Chance Showers And Thunderstorms then Mostly Cloudy",
        "detailedForecast": "A chance of showers and thunderstorms before midnight. Mostly cloudy, with a low around 61."
      },
      {
        "number": 13,
        "name": "Monday",
        "startTime": "2026-08-24T06:00:00-06:00",
        "endTime": "2026-08-24T18:00:00-06:00",
        "isDaytime": true,
        "temperature": 89,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 66
        },
        "windSpeed": "3 mph",
        "windDirection": "NNE",
        "icon": "https://api.weather.gov/icons/land/day/bkn/tsra_hi,70?size=medium",
        "shortForecast": "Partly Sunny then Showers And Thunderstorms Likely",
        "detailedForecast": "Showers and thunderstorms likely after noon. Partly sunny, with a high near 89."
      },
      {
        "number": 14,
        "name": "Monday Night",
        "startTime": "2026-08-24T18:00:00-06:00",
        "endTime": "2026-08-25T06:00:00-06:00",
        "isDaytime": false,
        "temperature": 60,
        "temperatureUnit": "F",
        "temperatureTrend": null,
        "probabilityOfPrecipitation": {
          "unitCode": "wmoUnit:percent",
          "value": 49
        },
        "windSpeed": "2 mph",
        "windDirection": "WSW",
        "icon": "https://api.weather.gov/icons/land/night/tsra_hi,50/bkn?size=medium",
        "shortForecast": "Chance Showers And Thunderstorms then Mostly Cloudy",
        "detailedForecast": "A chance of showers and thunderstorms before midnight. Mostly cloudy, with a low around 60."
      }
    ]
  }
}

export const STATIONS = {
  "features": [
    {
      "properties": {
        "stationIdentifier": "KBDU",
        "name": "Boulder Municipal Airport",
        "distance": { "unitCode": "wmoUnit:m", "value": 6437 }
      }
    },
    {
      "properties": {
        "stationIdentifier": "KLMO",
        "name": "Vance Brand Airport"
      }
    },
    {
      "properties": {
        "stationIdentifier": "KEIK",
        "name": "Erie Municipal Airport"
      }
    }
  ]
}

export const OBSERVATION = {
  "properties": {
    "@id": "https://api.weather.gov/stations/KBDU/observations/2026-08-18T12:15:00+00:00",
    "@type": "wx:ObservationStation",
    "elevation": {
      "unitCode": "wmoUnit:m",
      "value": 1612
    },
    "station": "https://api.weather.gov/stations/KBDU",
    "stationId": "KBDU",
    "stationName": "Boulder Municipal Airport",
    "timestamp": "2026-08-18T12:15:00+00:00",
    "rawMessage": "KBDU 181215Z AUTO 22005KT 10SM CLR 20/04 A3024 RMK AO2",
    "textDescription": "Clear",
    "icon": "https://api.weather.gov/icons/land/night/skc?size=medium",
    "presentWeather": [],
    "temperature": {
      "unitCode": "wmoUnit:degC",
      "value": 20,
      "qualityControl": "V"
    },
    "dewpoint": {
      "unitCode": "wmoUnit:degC",
      "value": 4,
      "qualityControl": "V"
    },
    "windDirection": {
      "unitCode": "wmoUnit:degree_(angle)",
      "value": 220,
      "qualityControl": "V"
    },
    "windSpeed": {
      "unitCode": "wmoUnit:km_h-1",
      "value": 9.36,
      "qualityControl": "V"
    },
    "windGust": {
      "unitCode": "wmoUnit:km_h-1",
      "value": null,
      "qualityControl": "Z"
    },
    "barometricPressure": {
      "unitCode": "wmoUnit:Pa",
      "value": 102410,
      "qualityControl": "V"
    },
    "seaLevelPressure": {
      "unitCode": "wmoUnit:Pa",
      "value": null,
      "qualityControl": "Z"
    },
    "visibility": {
      "unitCode": "wmoUnit:m",
      "value": 16090,
      "qualityControl": "C"
    },
    "maxTemperatureLast24Hours": {
      "unitCode": "wmoUnit:degC",
      "value": null
    },
    "minTemperatureLast24Hours": {
      "unitCode": "wmoUnit:degC",
      "value": null
    },
    "precipitationLastHour": {
      "unitCode": "wmoUnit:mm",
      "value": null,
      "qualityControl": "Z"
    },
    "precipitationLast3Hours": {
      "unitCode": "wmoUnit:mm",
      "value": null,
      "qualityControl": "Z"
    },
    "precipitationLast6Hours": {
      "unitCode": "wmoUnit:mm",
      "value": null,
      "qualityControl": "Z"
    },
    "relativeHumidity": {
      "unitCode": "wmoUnit:percent",
      "value": 34.828941973215,
      "qualityControl": "V"
    },
    "windChill": {
      "unitCode": "wmoUnit:degC",
      "value": null,
      "qualityControl": "V"
    },
    "heatIndex": {
      "unitCode": "wmoUnit:degC",
      "value": null,
      "qualityControl": "V"
    },
    "cloudLayers": [
      {
        "base": {
          "unitCode": "wmoUnit:m",
          "value": null
        },
        "amount": "CLR"
      }
    ]
  }
}

export const OUTSIDE_US = {
  "correlationId": "188962b5",
  "title": "Data Unavailable For Requested Point",
  "type": "https://api.weather.gov/problems/InvalidPoint",
  "status": 404,
  "detail": "Unable to provide data for requested point 51.5074,-0.1278"
}
