let render = () => {}

export function setRender(fn) { render = fn }

export function requestRender() { render() }
