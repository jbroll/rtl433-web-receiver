#pragma once

// Host stand-in for the ESP32 Arduino core's Preferences (NVS) wrapper,
// backed by an in-memory map instead of flash. Only the calls alias_store.cpp
// makes: begin(namespace, readOnly), putString(key, value), getString(key,
// default).

#include <map>
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

  bool remove(const char* key) {
    auto ns = _store.find(_ns);
    if (ns == _store.end()) return false;
    return ns->second.erase(key) > 0;
  }

 private:
  std::string _ns;
  // Shared across instances, like real NVS namespaces, so a Preferences
  // object that goes out of scope doesn't lose what it wrote.
  static std::map<std::string, std::map<std::string, std::string>> _store;
};

inline std::map<std::string, std::map<std::string, std::string>> Preferences::_store;
