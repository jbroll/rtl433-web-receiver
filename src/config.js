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
