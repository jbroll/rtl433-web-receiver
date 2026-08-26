import { test } from 'node:test'
import assert from 'node:assert/strict'

import { brokerLabel, readConfig } from '../src/config.js'

test('an empty environment gives the local defaults', () => {
  assert.deepEqual(readConfig({}), {
    mqttUrl: 'mqtt://localhost:1883',
    port: 8080,
    host: '0.0.0.0',
    username: undefined,
    password: undefined,
    embedBroker: true,
    mqttPort: 1883,
    mqttsPort: 8883,
    tlsCert: undefined,
    tlsKey: undefined,
    authToken: undefined,
    authTokenPath: undefined,
    dashboardHtmlPath: undefined,
    maxSseClients: 64,
    maxSseFilters: 16,
  })
})

test('the environment overrides every field', () => {
  const config = readConfig({
    MQTT_URL: 'mqtt://broker.local:1883',
    PORT: '9000',
    HOST: '127.0.0.1',
    MQTT_USERNAME: 'user',
    MQTT_PASSWORD: 'secret',
    EMBED_BROKER: 'false',
    MQTT_PORT: '11883',
    MQTTS_PORT: '18883',
    TLS_CERT: '/etc/cert.pem',
    TLS_KEY: '/etc/key.pem',
    AUTH_TOKEN: 'tok',
    AUTH_TOKEN_PATH: '/var/lib/bridge/auth-token',
    DASHBOARD_HTML: '/opt/bridge/public/index.html',
    MAX_SSE_CLIENTS: '32',
    MAX_SSE_FILTERS: '8',
  })
  assert.deepEqual(config, {
    mqttUrl: 'mqtt://broker.local:1883',
    port: 9000,
    host: '127.0.0.1',
    username: 'user',
    password: 'secret',
    embedBroker: false,
    mqttPort: 11883,
    mqttsPort: 18883,
    tlsCert: '/etc/cert.pem',
    tlsKey: '/etc/key.pem',
    authToken: 'tok',
    authTokenPath: '/var/lib/bridge/auth-token',
    dashboardHtmlPath: '/opt/bridge/public/index.html',
    maxSseClients: 32,
    maxSseFilters: 8,
  })
})

test('--auth-token-path overrides AUTH_TOKEN_PATH', () => {
  const config = readConfig(
    { AUTH_TOKEN_PATH: '/env/auth-token' },
    { authTokenPath: '/cli/auth-token' },
  )
  assert.equal(config.authTokenPath, '/cli/auth-token')
})

test('a PORT that is not a number is rejected rather than defaulted', () => {
  assert.throws(() => readConfig({ PORT: 'http' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '  ' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '8080.5' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '65536' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '-1' }), /PORT/)
  assert.equal(readConfig({ PORT: '0' }).port, 0)
  assert.equal(readConfig({ PORT: '65535' }).port, 65535)
  assert.throws(() => readConfig({ PORT: '0x1F90' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '1e3' }), /PORT/)
  assert.throws(() => readConfig({ PORT: '+80' }), /PORT/)
  assert.throws(() => readConfig({ PORT: 'Infinity' }), /PORT/)
})

test('MQTT_PORT and MQTTS_PORT validate the same way PORT does', () => {
  assert.throws(() => readConfig({ MQTT_PORT: 'x' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTT_PORT: '70000' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: 'x' }), /MQTTS_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: '-1' }), /MQTTS_PORT/)
})

test('MAX_SSE_CLIENTS and MAX_SSE_FILTERS default to 64 and 16, and reject non-positive values', () => {
  assert.equal(readConfig({}).maxSseClients, 64)
  assert.equal(readConfig({}).maxSseFilters, 16)
  assert.throws(() => readConfig({ MAX_SSE_CLIENTS: '0' }), /MAX_SSE_CLIENTS/)
  assert.throws(() => readConfig({ MAX_SSE_CLIENTS: 'x' }), /MAX_SSE_CLIENTS/)
  assert.throws(() => readConfig({ MAX_SSE_FILTERS: '-1' }), /MAX_SSE_FILTERS/)
  assert.throws(() => readConfig({ MAX_SSE_FILTERS: '' }), /MAX_SSE_FILTERS/)
})

test('CLI flags override the environment, which overrides the default', () => {
  const config = readConfig(
    { EMBED_BROKER: 'false', MQTT_PORT: '11883', AUTH_TOKEN: 'env-token' },
    { noEmbedBroker: false, mqttPort: '21883', authToken: 'cli-token' },
  )
  // --no-embed-broker was not passed (noEmbedBroker: false means "flag
  // absent", the same as node:util.parseArgs leaving a boolean flag unset).
  assert.equal(config.embedBroker, false)
  assert.equal(config.mqttPort, 21883)
  assert.equal(config.authToken, 'cli-token')
})

test('--no-embed-broker disables embedding even with no other config', () => {
  assert.equal(readConfig({}, { noEmbedBroker: true }).embedBroker, false)
})

test('EMBED_BROKER accepts false, no, and FALSE as disabling', () => {
  assert.equal(readConfig({ EMBED_BROKER: '0' }).embedBroker, false)
  assert.equal(readConfig({ EMBED_BROKER: 'no' }).embedBroker, false)
  assert.equal(readConfig({ EMBED_BROKER: 'FALSE' }).embedBroker, false)
})

test('an unrecognized EMBED_BROKER value is rejected rather than treated as true', () => {
  assert.throws(() => readConfig({ EMBED_BROKER: 'maybe' }), /EMBED_BROKER/)
})

test('--no-embed-broker wins over EMBED_BROKER set to true', () => {
  assert.equal(readConfig({ EMBED_BROKER: 'true' }, { noEmbedBroker: true }).embedBroker, false)
})

test('--broker-url overrides MQTT_URL', () => {
  const config = readConfig({ MQTT_URL: 'mqtt://env:1883' }, { brokerUrl: 'mqtt://cli:1883' })
  assert.equal(config.mqttUrl, 'mqtt://cli:1883')
})

test('--dashboard-html overrides DASHBOARD_HTML', () => {
  const config = readConfig({ DASHBOARD_HTML: '/env/index.html' }, { dashboardHtml: '/cli/index.html' })
  assert.equal(config.dashboardHtmlPath, '/cli/index.html')
})

test('the printable broker address keeps the host and port and drops the credentials', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtt://host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtts://alice@host.local'), 'mqtts://host.local')
  assert.equal(brokerLabel('not a url'), 'unknown')
})

test('a URL with no host falls back the same way one that fails to parse does', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@'), 'unknown')
})
