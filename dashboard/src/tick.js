import { signal } from '@preact/signals'

export const tick = signal(0)
// unref (a no-op in the browser, where the return value has no such method)
// so a unit test that imports this transitively can still exit on its own.
setInterval(() => tick.value++, 1000).unref?.()
