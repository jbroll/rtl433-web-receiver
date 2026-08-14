import { matchFilter } from './topic.js'

export function createCache() {
  const messages = new Map()

  return {
    set(topic, payload) {
      messages.set(topic, payload)
    },
    get(topic) {
      return messages.get(topic)
    },
    match(filter) {
      const found = []
      for (const [topic, payload] of messages) {
        if (matchFilter(filter, topic)) found.push([topic, payload])
      }
      return found
    },
    size() {
      return messages.size
    },
  }
}
