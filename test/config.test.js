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
  })
})

test('the environment overrides every field', () => {
  const config = readConfig({
    MQTT_URL: 'mqtt://broker.local:1883',
    PORT: '9000',
    HOST: '127.0.0.1',
    MQTT_USERNAME: 'user',
    MQTT_PASSWORD: 'secret',
  })
  assert.deepEqual(config, {
    mqttUrl: 'mqtt://broker.local:1883',
    port: 9000,
    host: '127.0.0.1',
    username: 'user',
    password: 'secret',
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

test('the printable broker address keeps the host and port and drops the credentials', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtt://host.local:1883'), 'mqtt://host.local:1883')
  assert.equal(brokerLabel('mqtts://alice@host.local'), 'mqtts://host.local')
  assert.equal(brokerLabel('not a url'), 'unknown')
})

test('a URL with no host falls back the same way one that fails to parse does', () => {
  assert.equal(brokerLabel('mqtt://alice:s3cr3t@'), 'unknown')
})
