#include <stdio.h>

#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "topic.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

static void badLine(int n, const char* why) {
  printf("line %d: %s\n", n, why);
  failures++;
}

// The topic rules are shared with bridge/src/topic.js; both suites run the
// same table so a change has to land in both implementations at once.
static void runSharedCases(const char* path) {
  std::ifstream in(path);
  if (!in) {
    check(path, false);
    printf("  cannot open the shared case table\n");
    return;
  }
  std::string line;
  int n = 0;
  while (std::getline(in, line)) {
    n++;
    if (line.empty() || line[0] == '#') continue;
    std::vector<std::string> f;
    std::string field;
    std::istringstream rest(line);
    while (std::getline(rest, field, '|')) f.push_back(field);
    if (f.size() < 3 || (f[0] == "matchFilter" && f.size() != 4)) {
      badLine(n, "malformed case line");
      continue;
    }
    const std::string& fn = f[0];
    const std::string& want = f.back();
    bool expected = want == "true";
    bool got = false;
    if (fn == "validTopic" && f.size() == 3) {
      got = topic::validTopic(f[1].c_str());
    } else if (fn == "validFilter" && f.size() == 3) {
      got = topic::validFilter(f[1].c_str());
    } else if (fn == "matchFilter" && f.size() == 4) {
      got = topic::matchFilter(f[1].c_str(), f[2].c_str());
    } else {
      badLine(n, "unknown function");
      continue;
    }
    check(line.c_str(), got == expected);
  }
}

int main(int argc, char** argv) {
  if (argc < 2) {
    printf("usage: %s <shared case table>\n", argv[0]);
    return 1;
  }
  runSharedCases(argv[1]);

  check("a $alias topic is an alias", topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234/$alias"));
  check("a source level $alias is an alias", topic::isAlias("rtl433-a1b2c3/$alias"));
  check("a device topic is not an alias", !topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("$alias not in the last segment is not an alias", !topic::isAlias("a/$alias/b"));
  check("validTopic rejects NULL", !topic::validTopic(NULL));

  check("isTz identifies a $tz topic", topic::isTz("src/Receiver/0/$tz"));
  check("isTz rejects a non-$tz topic", !topic::isTz("src/Acurite-5n1/396"));
  check("isTz rejects NULL", !topic::isTz(NULL));

  check("isLayout identifies a $layout topic", topic::isLayout("rtl433-a1b2c3/$layout"));
  check("a bare $layout is a layout topic", topic::isLayout("$layout"));
  check("isLayout rejects a non-$layout topic", !topic::isLayout("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("isLayout rejects NULL", !topic::isLayout(NULL));

  check("isLocation identifies a $location topic", topic::isLocation("rtl433-a1b2c3/$location"));
  check("a bare $location is a location topic", topic::isLocation("$location"));
  check("isLocation rejects a non-$location topic", !topic::isLocation("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("isLocation rejects NULL", !topic::isLocation(NULL));

  printf("%s\n", failures == 0 ? "topic: PASS" : "topic: FAIL");
  return failures == 0 ? 0 : 1;
}