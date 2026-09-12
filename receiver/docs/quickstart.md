# Quickstart

Build the dashboard the firmware embeds, then build and flash:

```
cd ../dashboard && npm install
cd ../receiver
pio run -e rfm69-433 -t upload
```

`rfm69-433` is the 433 MHz board (RFM69CW/SX1231); `sx1276-915` is the 915 MHz
board (SX1276). Pick the environment that matches the hardware in front of you
— the two have different pin maps, and the wrong one reads nothing back from
the radio.

On first boot the device opens a SoftAP named `rtl433-receiver-XXXX`: join
it, pick a WiFi network from the captive portal, and it reboots onto that
network. It then advertises itself over mDNS as `rtl433-` plus the last three
bytes of its MAC, so `avahi-browse -rtp _http._tcp | grep rtl433` names it and
gives its address. Browse to that name, `http://rtl433-4354c8.local` for a
device whose MAC ends `43:54:c8`, to see the dashboard it serves.

See [`docs/install.md`](install.md) for wiring and the `.env` shortcut that
skips the portal in dev, and [`docs/development.md`](development.md) for
testing without a radio.
