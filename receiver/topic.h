#pragma once

// No Arduino header: this module is also compiled on the host by
// test/host/run.sh, and its rules mirror mqtt-http-bridge/src/topic.js.
namespace topic {
bool validTopic(const char* topic);
bool validFilter(const char* filter);
bool matchFilter(const char* filter, const char* topic);
bool isAlias(const char* topic);
} // namespace topic
