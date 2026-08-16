import { effect } from '@preact/signals'

let renderAll = () => {}

export function setRender(fn) {
  renderAll = fn
}

export function scheduleRender() {
  setTimeout(renderAll, 0)
}

export function startRenderLoop(fn) {
  setRender(fn)
  effect(fn)
}
