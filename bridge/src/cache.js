export function createCache() {
  const messages = new Map()

  return {
    set(topic, payload) {
      messages.set(topic, payload)
    },
    delete(topic) {
      messages.delete(topic)
    },
    clear() {
      messages.clear()
    },
    get(topic) {
      return messages.get(topic)
    },
    entries() {
      return messages.entries()
    },
    size() {
      return messages.size
    },
  }
}
