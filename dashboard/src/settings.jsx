import { settings, setUnits, setDecimals, setCustomField } from './settings.js'
import { LocationView } from './location.jsx'
import { SourcesView } from './sources.jsx'
import { BridgesView } from './bridges.jsx'

const DECIMALS = [0, 1, 2, 3, 4, 5]

const GROUPS = {
  temp: { label: 'Temperature', options: [['C', '°C'], ['F', '°F']] },
  rain: { label: 'Rain', options: [['mm', 'mm'], ['in', 'in']] },
  wind: { label: 'Wind', options: [['km/h', 'km/h'], ['mi/h', 'mi/h'], ['m/s', 'm/s']] },
  pressure: { label: 'Pressure', options: [['hPa', 'hPa'], ['kPa', 'kPa']] },
}

export function SettingsView() {
  const s = settings.value

  return (
    <div id="settings">
      <div>
        <label>
          Decimals
          <select id="settings-decimals" value={s.decimals}
                  onChange={(e) => setDecimals(parseInt(e.target.value, 10))}>
            {DECIMALS.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label>
          Units
          <select id="settings-units" value={s.units}
                  onChange={(e) => setUnits(e.target.value)}>
            <option value="metric">Metric</option>
            <option value="imperial">Imperial</option>
            <option value="custom">Custom</option>
          </select>
        </label>
      </div>
      {s.units === 'custom' && (
        <div id="settings-custom">
          {Object.entries(GROUPS).map(([group, { label, options }]) => (
            <label key={group}>
              {label}
              <select id={`settings-${group}`} value={s.custom[group]}
                      onChange={(e) => setCustomField(group, e.target.value)}>
                {options.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
      <LocationView />
      <div id="settings-sources">
        <SourcesView />
      </div>
      <div id="settings-bridges">
        <BridgesView />
      </div>
    </div>
  )
}
