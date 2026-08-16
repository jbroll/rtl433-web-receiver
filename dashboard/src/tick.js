import { signal } from '@preact/signals'

export const tick = signal(0)
setInterval(() => tick.value++, 1000)
