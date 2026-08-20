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
  })
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
})

test('MQTT_PORT and MQTTS_PORT validate the same way PORT does', () => {
  assert.throws(() => readConfig({ MQTT_PORT: 'x' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTT_PORT: '70000' }), /MQTT_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: 'x' }), /MQTTS_PORT/)
  assert.throws(() => readConfig({ MQTTS_PORT: '-1' }), /MQTTS_PORT/)
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

test('--broker-url overrides MQTT_URL', () => {
  const config = readConfig({ MQTT_URL: 'mqtt://env:1883' }, { brokerUrl: 'mqtt://cli:1883' })
  assert.equal(config.mqttUrl, 'mqtt://cli:1883')
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
