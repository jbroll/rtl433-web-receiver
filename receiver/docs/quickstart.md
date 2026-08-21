# Quickstart

Build the dashboard the firmware embeds, then build and flash:

```
cd ../dashboard && npm install
cd ../receiver
pio run -e esp32s3-generic -t upload
```

On first boot the device opens a SoftAP named `rtl433-receiver-XXXX`: join
it, pick a WiFi network from the captive portal, and it reboots onto that
network. Browse to the receiver's IP, or `http://rtl433.local`, to see the
dashboard it serves.

See [`docs/install.md`](install.md) for wiring and the `.env` shortcut that
skips the portal in dev, and [`docs/development.md`](development.md) for
testing without a radio.
