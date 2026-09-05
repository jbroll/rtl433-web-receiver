import { Capacitor } from '@capacitor/core'
import { KeepAwake } from '@capacitor-community/keep-awake'

// The tablet is a wall display, so the dashboard is useless the moment the
// screen sleeps. The app holds the screen on itself rather than leaning on the
// device's Auto-Lock setting, which any passer-by can change and which Low
// Power Mode overrides to 30 seconds regardless.
export function holdScreenAwake() {
  if (!Capacitor.isNativePlatform()) return
  KeepAwake.keepAwake().catch(err => {
    console.error(`keepAwake failed: ${err && err.message ? err.message : err}`)
  })
}
