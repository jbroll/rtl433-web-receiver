// mqtt.connect takes credentials in the URL, so printing MQTT_URL verbatim
// puts a password in the log of every service that runs the bridge.
export function brokerLabel(url) {
  try {
    const { protocol, host } = new URL(url)
    // A URL that parses but has no host, e.g. "mqtt://alice:s3cr3t@", falls
    // through to the same fallback as one that doesn't parse at all: every
    // caller embeds this in "broker <label>", where the old fallback,
    // "the broker", read as "broker the broker".
    return host ? `${protocol}//${host}` : 'unknown'
  } catch {
    return 'unknown'
  }
}

// Number('') and Number('  ') are both 0, which would otherwise pass
// validation and silently bind an ephemeral port. Shared by PORT,
// MQTT_PORT, and MQTTS_PORT, which all take the same kind of value.
function parsePort(name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const digitsOnly = typeof raw === 'string' && /^\d+$/.test(raw.trim())
  const value = digitsOnly ? Number(raw.trim()) : NaN
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number, got ${JSON.stringify(raw)}`)
  }
  return value
}

const BOOLEAN_WORDS = {
  true: true, '1': true, yes: true, on: true,
  false: false, '0': false, no: false, off: false,
}

function parseBoolean(name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const value = BOOLEAN_WORDS[String(raw).trim().toLowerCase()]
  if (value === undefined) {
    throw new Error(`${name} must be one of true/false/1/0/yes/no/on/off, got ${JSON.stringify(raw)}`)
  }
  return value
}

export function readConfig(env, cli = {}) {
  const port = parsePort('PORT', env.PORT, 8080)
  const mqttPort = parsePort('MQTT_PORT', cli.mqttPort ?? env.MQTT_PORT, 1883)
  const mqttsPort = parsePort('MQTTS_PORT', cli.mqttsPort ?? env.MQTTS_PORT, 8883)

  const embedBroker = cli.noEmbedBroker ? false : parseBoolean('EMBED_BROKER', env.EMBED_BROKER, true)

  return {
    mqttUrl: cli.brokerUrl ?? env.MQTT_URL ?? 'mqtt://localhost:1883',
    port,
    host: env.HOST ?? '0.0.0.0',
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    embedBroker,
    mqttPort,
    mqttsPort,
    tlsCert: cli.tlsCert ?? env.TLS_CERT,
    tlsKey: cli.tlsKey ?? env.TLS_KEY,
    authToken: cli.authToken ?? env.AUTH_TOKEN,
    authTokenPath: cli.authTokenPath ?? env.AUTH_TOKEN_PATH,
    dashboardHtmlPath: cli.dashboardHtml ?? env.DASHBOARD_HTML,
  }
}
