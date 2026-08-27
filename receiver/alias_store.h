#pragma once

#include <Arduino.h>

#include "signal_store.h"

#define ALIAS_SLOTS     32
// A device key plus "/$alias".
#define ALIAS_TOPIC_MAX (SIGNAL_KEY_MAX + 7)
#define ALIAS_NAME_MAX  32
// Every one of ALIAS_NAME_MAX characters can escape to \u00xx, plus two
// quotes and the terminator.
#define ALIAS_PAYLOAD_MAX (ALIAS_NAME_MAX * 6 + 3)
// NVS keys are limited to 15 characters and an alias topic runs past 100, so
// the whole table is one blob under one key rather than an entry per alias.
// The blob does not hold 32 full-length entries; set() fails once it is full.
#define ALIAS_BLOB_MAX  2048

namespace alias_store {
bool        begin();
const char* get(const char* topic);
bool        set(const char* topic, const char* name);
bool        remove(const char* topic);
uint8_t     count();
// Raw table index rather than order of insertion, so a cursor over it does not
// skip or repeat an entry when one is added or removed mid-walk. NULL for a
// free entry.
const char* topicAt(uint8_t i);
const char* nameAt(uint8_t i);
// The topic's raw table index, or -1 if it has no alias.
int         indexOf(const char* topic);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace alias_store
