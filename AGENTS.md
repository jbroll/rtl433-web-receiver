# Agent notes for rtl433-web-receiver

> ## READ FIRST — serial monitor
>
> **`receiver/monitor.py` is a ready-to-go headless serial monitor for the ESP32-S3 receiver.**
> Use it for ANY serial capture. Do NOT reach for `pio device monitor` (it needs an
> interactive TTY and dies when run through a pipe) and do NOT write throwaway
> inline `pyserial`/heredoc snippets — monitor.py already does all of that.
>
> ```sh
> python3 receiver/monitor.py -d 12              # capture 12 s of boot log (resets the board)
> python3 receiver/monitor.py --port /dev/ttyACM0 --no-reset -t   # stream, timestamped, no reset
> ```
>
> It auto-picks the first `ttyACM*`/`ttyUSB*` port, reads `monitor_speed` from
> `platformio.ini`, resets the board into the app on connect, and prints decoded
> lines. Extra flags: `-q` to suppress binary startup bytes, `-d/--duration` seconds.