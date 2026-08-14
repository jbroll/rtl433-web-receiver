#pragma once

#include <Arduino.h>

#define ALIAS_SLOTS     32
#define ALIAS_TOPIC_MAX 96
#define ALIAS_NAME_MAX  32
// NVS keys are limited to 15 characters and an alias topic runs to 96, so the
// whole table is one blob under one key rather than an entry per alias.
#define ALIAS_BLOB_MAX  2048

namespace alias_store {
bool        begin();
const char* get(const char* topic);
bool        set(const char* topic, const char* name);
bool        remove(const char* topic);
uint8_t     count();
const char* topicAt(uint8_t i);
const char* nameAt(uint8_t i);
#ifdef FAKE_SIGNALS
bool selfTest();
#endif
} // namespace alias_store
