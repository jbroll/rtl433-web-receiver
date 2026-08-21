import { useState } from 'preact/hooks'
import { settings, setLocation, clearLocation, localZone } from './settings.js'
import { geocode, reverseGeocode } from './geocode.js'
import { Map, Marker } from 'pigeon-maps'

// pigeon-maps defaults to a provider we do not want; OSM's own tiles are the
// ones the attribution below credits.
const osm = (x, y, z) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`

const ATTRIBUTION = (
  <span>&copy; <a href="https://www.openstreetmap.org/copyright"
                  target="_blank" rel="noreferrer">OpenStreetMap</a> contributors</span>
)

// Where a newly chosen place lands. The whole-country view the map opens on
// before a location exists is not a zoom worth keeping.
const PLACE_ZOOM = 11
const WORLD = { center: [39.83, -98.58], zoom: 3 }

function zones() {
  try { return Intl.supportedValuesOf('timeZone') } catch (e) { return [] }
}

function num(v) {
  const n = Number(v)
  return v === '' || !Number.isFinite(n) ? null : n
}

export function LocationView() {
  const loc = settings.value.location
  const hasLocal = loc.lat !== null && loc.lon !== null
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  // geolocation is refused outside a secure context, and the firmware serves
  // the page over plain http on a LAN address.
  const canLocate = typeof navigator !== 'undefined' && navigator.geolocation
                    && typeof isSecureContext !== 'undefined' && isSecureContext

  async function search() {
    if (busy) return
    setBusy(true)
    setStatus('Searching…')
    setResults([])
    try {
      const found = await geocode(query)
      setResults(found)
      setStatus(found.length ? '' : 'Nothing found')
    } catch (e) {
      setStatus(e.message || 'Search failed')
    } finally {
      setBusy(false)
    }
  }

  function pick(p) {
    setLocation({ lat: p.lat, lon: p.lon, label: p.label, zoom: PLACE_ZOOM })
    setResults([])
    setQuery('')
    setStatus('')
  }

  function locate() {
    setStatus('Locating…')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setLocation({ lat: latitude, lon: longitude, label: '', zoom: PLACE_ZOOM })
        setStatus('')
        try { setLocation({ label: await reverseGeocode(latitude, longitude) }) } catch (e) {}
      },
      (err) => setStatus(err.message || 'Could not get your location'))
  }

  const TZ = zones()

  return (
    <div id="settings-location">
      <div class="row">
        <label>
          Place
          <input id="settings-place" type="text" value={query} placeholder="Boulder, Colorado"
                 onInput={(e) => setQuery(e.target.value)}
                 onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search() } }} />
        </label>
        <button id="settings-place-go" onClick={search} disabled={busy}>Search</button>
        {canLocate && <button id="settings-geolocate" onClick={locate}>Use my location</button>}
      </div>

      {results.length > 0 && (
        <ul id="settings-place-results">
          {results.map(p => (
            <li key={`${p.lat},${p.lon}`}>
              <button onClick={() => pick(p)}>{p.label}</button>
            </li>
          ))}
        </ul>
      )}

      <div class="row">
        <label>
          Latitude
          <input id="settings-lat" type="number" step="any" min="-90" max="90"
                 value={loc.lat === null ? '' : loc.lat}
                 onChange={(e) => setLocation({ lat: num(e.target.value) })} />
        </label>
        <label>
          Longitude
          <input id="settings-lon" type="number" step="any" min="-180" max="180"
                 value={loc.lon === null ? '' : loc.lon}
                 onChange={(e) => setLocation({ lon: num(e.target.value) })} />
        </label>
        <label>
          Time zone
          <select id="settings-zone" value={loc.zone}
                  onChange={(e) => setLocation({ zone: e.target.value })}>
            <option value="">{localZone()} (this device)</option>
            {TZ.map(z => <option key={z} value={z}>{z}</option>)}
          </select>
        </label>
        {hasLocal && <button id="settings-location-clear" onClick={clearLocation}>Clear</button>}
      </div>

      <div id="settings-map">
        <Map
          provider={osm}
          dprs={[1, 2]}
          height={220}
          center={loc.lat === null ? WORLD.center : [loc.lat, loc.lon]}
          zoom={loc.lat === null ? WORLD.zoom : loc.zoom}
          attribution={ATTRIBUTION}
          attributionPrefix={false}
          onClick={({ latLng }) => setLocation({ lat: latLng[0], lon: latLng[1], label: '' })}
          onBoundsChanged={({ zoom }) => {
            // Only once there is a place to zoom on: otherwise the opening
            // whole-country view overwrites the zoom a pick is about to set.
            if (loc.lat !== null && Math.round(zoom) !== loc.zoom) setLocation({ zoom: Math.round(zoom) })
          }}
        >
          {loc.lat !== null && <Marker width={34} anchor={[loc.lat, loc.lon]} color="currentColor" />}
        </Map>
      </div>

      <div id="settings-location-status">
        {status || (hasLocal ? loc.label || `${loc.lat}, ${loc.lon}` : 'No location set')}
      </div>
    </div>
  )
}
