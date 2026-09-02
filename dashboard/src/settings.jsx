import { settings, setUnits, setDecimals, setCustomField } from './settings.js'
import { tokenFor, setToken } from './auth.js'
import { LocationView } from './location.jsx'
import { SourcesView } from './sources.jsx'
import { BridgesView } from './bridges.jsx'
import { FeedsView } from './feeds.jsx'

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
      <div id="settings-feeds">
        <FeedsView />
      </div>
      <div id="settings-auth">
        <AuthView />
      </div>
    </div>
  )
}

// The token gates writes to the origin serving this page, so one field is enough.
function AuthView() {
  let input
  const origin = location.origin
  const has = tokenFor(origin) !== ''
  return (
    <form id="auth-form" onSubmit={(ev) => {
      ev.preventDefault()
      setToken(origin, input.value)
      input.value = ''
    }}>
      <label>
        Write access token
        <input
          id="settings-token"
          type="password"
          autocomplete="off"
          placeholder={has ? 'token set — save empty to clear' : 'none set'}
          aria-label="Write access token"
          ref={(el) => { input = el }}
        />
      </label>
      <button id="settings-token-save" type="submit">Save</button>
    </form>
  )
}
