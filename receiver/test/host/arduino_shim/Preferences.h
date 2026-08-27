#pragma once

// Host stand-in for the ESP32 Arduino core's Preferences (NVS) wrapper,
// backed by an in-memory map instead of flash. Only the calls the stores
// make: begin(namespace, readOnly), putString/getString, putBytes/getBytes/
// getBytesLength, and remove.

#include <cstring>
#include <map>
#include <set>
#include <string>

#include "Arduino.h"

class Preferences {
 public:
  bool begin(const char* name, bool readOnly) {
    _ns = name ? name : "";
    (void)readOnly;
    return true;
  }

  void end() { _ns.clear(); }

  size_t putString(const char* key, const char* value) {
    _store[_ns][key] = value ? value : "";
    return _store[_ns][key].size();
  }

  String getString(const char* key, const char* defaultValue) {
    auto ns = _store.find(_ns);
    if (ns != _store.end()) {
      auto it = ns->second.find(key);
      if (it != ns->second.end()) {
        return String(it->second.c_str());
      }
    }
    return String(defaultValue);
  }

  // NVS keys are typed, so a getBytes* on a key holding a string reads as
  // absent, which is what layout_store's migration off putString relies on.
  size_t putBytes(const char* key, const void* value, size_t len) {
    _store[_ns][key].assign((const char*)value, len);
    _blobs[_ns].insert(key);
    return len;
  }

  size_t getBytesLength(const char* key) {
    if (_blobs[_ns].count(key) == 0) return 0;
    auto ns = _store.find(_ns);
    if (ns == _store.end()) return 0;
    auto it = ns->second.find(key);
    return it == ns->second.end() ? 0 : it->second.size();
  }

  size_t getBytes(const char* key, void* buf, size_t maxLen) {
    size_t n = getBytesLength(key);
    if (n == 0 || n > maxLen) return 0;
    memcpy(buf, _store[_ns][key].data(), n);
    return n;
  }

  size_t putShort(const char* key, int16_t value) {
    return putBytes(key, &value, sizeof(value));
  }

  int16_t getShort(const char* key, int16_t defaultValue) {
    int16_t value = defaultValue;
    return getBytes(key, &value, sizeof(value)) == sizeof(value) ? value : defaultValue;
  }

  bool remove(const char* key) {
    auto ns = _store.find(_ns);
    if (ns == _store.end()) return false;
    _blobs[_ns].erase(key);
    return ns->second.erase(key) > 0;
  }

 private:
  std::string _ns;
  // Shared across instances, like real NVS namespaces, so a Preferences
  // object that goes out of scope doesn't lose what it wrote.
  static std::map<std::string, std::map<std::string, std::string>> _store;
  static std::map<std::string, std::set<std::string>>              _blobs;
};

inline std::map<std::string, std::map<std::string, std::string>> Preferences::_store;
inline std::map<std::string, std::set<std::string>>              Preferences::_blobs;
