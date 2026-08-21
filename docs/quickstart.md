# Quickstart

Build the dashboard, flash the receiver, and see a signal on the page.

```
cd dashboard && npm install && npm run build
cd ../receiver && pio run -e esp32s3-generic -t upload
```

The receiver embeds the dashboard build, wires up over WiFi (see
[`receiver/docs/install.md`](../receiver/docs/install.md) for first-boot
provisioning), and serves the page itself: browse to the receiver's IP or
`http://rtl433.local`.

To read from a bridge instead of, or in addition to, a receiver, see
[`bridge/docs/quickstart.md`](../bridge/docs/quickstart.md) and add its URL in
the dashboard's settings panel.

Each sub-project has its own quickstart and full docs:

- [`receiver/docs/quickstart.md`](../receiver/docs/quickstart.md)
- [`bridge/docs/quickstart.md`](../bridge/docs/quickstart.md)
- [`dashboard/docs/quickstart.md`](../dashboard/docs/quickstart.md)

Run every sub-project's test suite in one command:

```
bin/test.sh
```
