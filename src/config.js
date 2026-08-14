// mqtt.connect takes credentials in the URL, so printing MQTT_URL verbatim
// puts a password in the log of every service that runs the bridge.
export function brokerLabel(url) {
  try {
    const { protocol, host } = new URL(url)
    return `${protocol}//${host}`
  } catch {
    return 'the broker'
  }
}

export function readConfig(env) {
  // Number('') and Number('  ') are both 0, which would otherwise pass
  // validation and silently bind an ephemeral port.
  const blank = typeof env.PORT === 'string' && env.PORT.trim() === ''
  const port = env.PORT === undefined ? 8080 : Number(env.PORT)
  if (blank || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got ${JSON.stringify(env.PORT)}`)
  }

  return {
    mqttUrl: env.MQTT_URL ?? 'mqtt://localhost:1883',
    port,
    host: env.HOST ?? '0.0.0.0',
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
  }
}
