#include <stdio.h>

#include "topic.h"

static int failures = 0;

static void check(const char* what, bool ok) {
  printf("%-64s %s\n", what, ok ? "PASS" : "FAIL");
  if (!ok) failures++;
}

int main() {
  check("a three segment topic is valid", topic::validTopic("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("an empty topic is invalid", !topic::validTopic(""));
  check("a topic holding + is invalid", !topic::validTopic("a/+/c"));
  check("a topic holding # is invalid", !topic::validTopic("a/#"));
  check("a topic holding a space is invalid", !topic::validTopic("a/b c/d"));
  check("a topic with an empty segment is invalid", !topic::validTopic("a//c"));
  check("a topic with a trailing slash is invalid", !topic::validTopic("a/b/"));
  check("a one segment topic is valid", topic::validTopic("rtl433-a1b2c3"));

  check("# alone is a valid filter", topic::validFilter("#"));
  check("+ in the middle is a valid filter", topic::validFilter("a/+/c"));
  check("# as the last segment is a valid filter", topic::validFilter("a/b/#"));
  check("# before the last segment is invalid", !topic::validFilter("a/#/c"));
  check("# inside a segment is invalid", !topic::validFilter("a/b#/c"));
  check("+ inside a segment is invalid", !topic::validFilter("a/b+/c"));
  check("an empty filter is invalid", !topic::validFilter(""));
  check("a filter holding a space is invalid", !topic::validFilter("a/b c"));

  check("# matches everything", topic::matchFilter("#", "a/b/c"));
  check("# matches the remainder", topic::matchFilter("a/#", "a/b/c"));
  check("# matches its own prefix", topic::matchFilter("a/#", "a"));
  check("# does not match another prefix", !topic::matchFilter("a/#", "b/c"));
  check("+ matches exactly one segment", topic::matchFilter("a/+/c", "a/b/c"));
  check("+ does not span a separator", !topic::matchFilter("a/+/c", "a/b/x/c"));
  check("+ does not match a missing segment", !topic::matchFilter("a/+/c", "a/c"));
  check("an exact filter matches its topic", topic::matchFilter("a/b/c", "a/b/c"));
  check("a longer topic does not match an exact filter", !topic::matchFilter("a/b", "a/b/c"));
  check("a shorter topic does not match an exact filter", !topic::matchFilter("a/b/c", "a/b"));
  check("+ matches a whole one segment topic", topic::matchFilter("+", "a"));

  check("a $alias topic is an alias", topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234/$alias"));
  check("a source level $alias is an alias", topic::isAlias("rtl433-a1b2c3/$alias"));
  check("a device topic is not an alias", !topic::isAlias("rtl433-a1b2c3/Acurite-5n1/1234"));
  check("$alias not in the last segment is not an alias", !topic::isAlias("a/$alias/b"));

  check("isTz identifies a $tz topic", topic::isTz("src/Receiver/0/$tz"));
  check("isTz rejects a non-$tz topic", !topic::isTz("src/Acurite-5n1/396"));
  check("isTz rejects NULL", !topic::isTz(NULL));

  printf("%s\n", failures == 0 ? "topic: PASS" : "topic: FAIL");
  return failures == 0 ? 0 : 1;
}
