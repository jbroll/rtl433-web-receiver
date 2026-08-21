#pragma once

// No Arduino header: this module is also compiled on the host by
// test/host/run.sh, and its rules run the shared case table
// test/topic_cases.txt alongside bridge/src/topic.js.
namespace topic {
bool validTopic(const char* topic);
bool validFilter(const char* filter);
bool matchFilter(const char* filter, const char* topic);
bool isAlias(const char* topic);
bool isTz(const char* topic);
bool isLayout(const char* topic);
} // namespace topic
