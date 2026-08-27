#include <stdio.h>
#include <string.h>

#include <ArduinoJson.h>

#include "mqtt_publish.h"
#include "mqtt_publish_store.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-72s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

// Index into mqtt_publish's active list (post-begin()) whose urlAt() matches,
// or -1. Scenarios look their broker up by url since begin() can reassign
// which _conn[] slot serves it.
static int findByUrl(const char* url) {
  for (uint8_t i = 0; i < mqtt_publish::count(); i++) {
    const char* u = mqtt_publish::urlAt(i);
    if (u != nullptr && strcmp(u, url) == 0) return (int)i;
  }
  return -1;
}

// urlAt() is indexed by slot, not compacted, so a prior remove() can leave a
// hole before the end; scan every slot rather than assuming index 0 is live.
static void clearStore() {
  for (uint8_t i = 0; i < MQTT_PUBLISH_SLOTS; i++) {
    const char* url = mqtt_publish_store::urlAt(i);
    if (url != nullptr) mqtt_publish_store::remove(url);
  }
}

// Empties the dashboard table and reconverges, leaving only the build-flag
// broker (if any) alive, so each scenario starts from a known baseline
// rather than whatever the previous scenario's begin() left behind.
static void resetBaseline() {
  clearStore();
  mqtt_publish::begin("test-client");
  // Wipe every physical slot's fakes, live or not: a scenario asserting "no
  // call happened" would otherwise see counts left over from whichever
  // unrelated broker last occupied this slot.
  for (uint8_t i = 0; i < mqtt_publish::maxConnections(); i++) {
    mqtt_publish::mqttRawAt(i).resetForTest();
    mqtt_publish::plainClientRawAt(i).resetForTest();
    mqtt_publish::secureClientRawAt(i).resetForTest();
  }
}

// A handle into one live _conn[] slot's fakes, captured before a mutating
// begin(), so "was this slot torn down" survives that begin() reassigning
// slot indices out from under a plain index.
struct ConnHandle {
  PubSubClient*     mqtt;
  WiFiClient*       plain;
  WiFiClientSecure* secure;
  int               disconnectBefore;
  int               plainStopBefore;
  int               secureStopBefore;
};

static ConnHandle capture(uint8_t i) {
  ConnHandle h;
  h.mqtt             = &mqtt_publish::mqttAt(i);
  h.plain            = &mqtt_publish::plainClientAt(i);
  h.secure           = &mqtt_publish::secureClientAt(i);
  h.disconnectBefore = h.mqtt->disconnectCalls;
  h.plainStopBefore  = h.plain->stopCalls;
  h.secureStopBefore = h.secure->stopCalls;
  return h;
}

// teardown() always stops both clients, whether or not the broker was TLS;
// disconnect() only fires if PubSubClient thought it was connected.
static bool wasTornDown(const ConnHandle& h) {
  return h.plain->stopCalls > h.plainStopBefore || h.secure->stopCalls > h.secureStopBefore;
}

static void scenario_addThird() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "t1");
  mqtt_publish_store::add("mqtt://b2.example:1883", "t2");
  mqtt_publish::begin("test-client");
  int i1 = findByUrl("mqtt://b1.example:1883");
  int i2 = findByUrl("mqtt://b2.example:1883");
  check("(a) both initial brokers are set up", i1 >= 0 && i2 >= 0);
  ConnHandle h1 = capture((uint8_t)i1);
  ConnHandle h2 = capture((uint8_t)i2);

  mqtt_publish_store::add("mqtt://b3.example:1883", "t3");
  mqtt_publish::begin("test-client");

  check("(a) adding a third broker does not tear down the first",
        !wasTornDown(h1));
  check("(a) adding a third broker does not tear down the second",
        !wasTornDown(h2));
  check("(a) the third broker is set up and reachable",
        findByUrl("mqtt://b3.example:1883") >= 0);
}

static void scenario_removeMiddle() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "t1");
  mqtt_publish_store::add("mqtt://b2.example:1883", "t2");
  mqtt_publish_store::add("mqtt://b3.example:1883", "t3");
  mqtt_publish::begin("test-client");
  int i1 = findByUrl("mqtt://b1.example:1883");
  int i3 = findByUrl("mqtt://b3.example:1883");
  ConnHandle h1 = capture((uint8_t)i1);
  ConnHandle h3 = capture((uint8_t)i3);

  mqtt_publish_store::remove("mqtt://b2.example:1883");
  mqtt_publish::begin("test-client");

  check("(b) removing the middle broker leaves the first untorn-down",
        !wasTornDown(h1));
  check("(b) removing the middle broker leaves the third untorn-down",
        !wasTornDown(h3));
  check("(b) the removed broker no longer appears in the active list",
        findByUrl("mqtt://b2.example:1883") < 0);
}

static void scenario_tokenChanged() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "old-token");
  mqtt_publish_store::add("mqtt://b2.example:1883", "unchanged");
  mqtt_publish::begin("test-client");
  int i1 = findByUrl("mqtt://b1.example:1883");
  int i2 = findByUrl("mqtt://b2.example:1883");
  ConnHandle h1 = capture((uint8_t)i1);
  ConnHandle h2 = capture((uint8_t)i2);

  mqtt_publish_store::add("mqtt://b1.example:1883", "new-token");
  mqtt_publish::begin("test-client");

  check("(c) a changed token re-handshakes its own slot",
        wasTornDown(h1));
  check("(c) a changed token leaves an unrelated same-url-scheme slot alone",
        !wasTornDown(h2));
}

static void scenario_schemeFlips() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "t1");
  mqtt_publish::begin("test-client");
  int i1 = findByUrl("mqtt://b1.example:1883");
  ConnHandle h1 = capture((uint8_t)i1);

  mqtt_publish_store::remove("mqtt://b1.example:1883");
  mqtt_publish_store::add("mqtts://b1.example:1883", "t1");
  mqtt_publish::begin("test-client");

  check("(d) a url whose scheme flips TLS tears down the old slot",
        wasTornDown(h1));
  check("(d) both clients on that slot were stopped",
        h1.plain->stopCalls > h1.plainStopBefore && h1.secure->stopCalls > h1.secureStopBefore);
  check("(d) the new TLS broker is set up",
        findByUrl("mqtts://b1.example:1883") >= 0);
}

static void scenario_invalidUrl() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "t1");
  // Passes mqtt_publish_store::validUrl (scheme + length only) but fails
  // mqtt_publish's own parseBrokerUrl, which requires a ":port".
  mqtt_publish_store::add("mqtt://host", "t2");
  mqtt_publish::begin("test-client");

  int bad = findByUrl("mqtt://host");
  check("(e) an unparseable url is still counted", bad >= 0);
  check("(e) it is reported disabled with a reason",
        bad >= 0 && !mqtt_publish::connectedAt((uint8_t)bad) &&
            mqtt_publish::reasonAt((uint8_t)bad) != nullptr);
  check("(e) it was never handed a server (setupConnection bailed before setServer)",
        bad >= 0 && mqtt_publish::mqttAt((uint8_t)bad).setServerCalls == 0);
}

static void scenario_exactFit() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://b1.example:1883", "t1");
  mqtt_publish_store::add("mqtt://b2.example:1883", "t2");
  mqtt_publish_store::add("mqtt://b3.example:1883", "t3");
  mqtt_publish::begin("test-client");
  check("(f) the build-flag broker plus three slots exactly fills _conn[]",
        mqtt_publish::count() == 4);

  ConnHandle h[4];
  for (uint8_t i = 0; i < 4; i++) h[i] = capture(i);

  mqtt_publish::begin("test-client");  // no store change: a pure no-op

  bool anyTornDown = false;
  for (uint8_t i = 0; i < 4; i++) anyTornDown |= wasTornDown(h[i]);
  check("(f) a no-op begin() on a full table tears nothing down", !anyTornDown);
}

static void scenario_bufferAllocFailure() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://oom.example:1883", "t1");
  PubSubClient::failNextSetBufferSize = true;
  mqtt_publish::begin("test-client");

  int i = findByUrl("mqtt://oom.example:1883");
  check("(oom) a slot whose buffer alloc fails is still counted", i >= 0);
  check("(oom) it is disabled, not enabled",
        i >= 0 && !mqtt_publish::connectedAt((uint8_t)i));
  check("(oom) its reason is the out-of-memory one",
        i >= 0 && mqtt_publish::reasonAt((uint8_t)i) != nullptr &&
            strcmp(mqtt_publish::reasonAt((uint8_t)i), "out of memory growing publish buffer") == 0);
  check("(oom) setupConnection bailed before setServer",
        i >= 0 && mqtt_publish::mqttAt((uint8_t)i).setServerCalls == 0);
}

static void scenario_aliasPayloadEscaping() {
  resetBaseline();
  mqtt_publish_store::add("mqtt://alias.example:1883", "t1");
  mqtt_publish::begin("test-client");
  int i = findByUrl("mqtt://alias.example:1883");
  mqtt_publish::mqttAt((uint8_t)i).setConnectedForTest(true);

  // A quote, a backslash, and a control byte (0x01): the three escape paths
  // aliasPayload/writeJsonString has to cover.
  // "\x01" "d", not "\x01d": \x consumes every following hex digit, and
  // 'd' is one, so the two literals must be split to keep the byte 0x01.
  const char* name = "a\"b\\c\x01" "d";
  mqtt_publish::publishAlias("rtl_433/alias/test", name);

  const char* payload = mqtt_publish::mqttAt((uint8_t)i).lastPublishPayload;
  check("(alias) a publish happened", payload != nullptr);
  if (payload == nullptr) return;

  const char* expected = "\"a\\\"b\\\\c\\u0001d\"";
  check("(alias) the payload matches the expected escaping exactly",
        strcmp(payload, expected) == 0);
  check("(alias) no raw control byte survives in the payload",
        strchr(payload, 0x01) == nullptr);

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  check("(alias) the payload parses as valid JSON",
        err == DeserializationError::Ok && doc.is<const char*>());
}

int main() {
  scenario_addThird();
  scenario_removeMiddle();
  scenario_tokenChanged();
  scenario_schemeFlips();
  scenario_invalidUrl();
  scenario_exactFit();
  scenario_bufferAllocFailure();
  scenario_aliasPayloadEscaping();

  printf("%s\n", failures == 0 ? "mqtt_publish: PASS" : "mqtt_publish: FAIL");
  return failures == 0 ? 0 : 1;
}
