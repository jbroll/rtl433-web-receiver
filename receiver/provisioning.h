#pragma once

namespace provisioning {
// Blocks until credentials are saved via the captive portal, then reboots.
// Never returns during normal operation.
void run();
} // namespace provisioning
