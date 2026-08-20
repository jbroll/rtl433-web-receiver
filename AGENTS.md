# Agent notes for rtl433-web-receiver

> ## ⛔ STOP. READ THIS FIRST. ⛔
>
> **`receiver/monitor.py` is THE serial monitor. There is no other.**
>
> Any time you touch a serial port — boot logs, radio init diagnostics, streaming,
> probe output, anything — use `receiver/monitor.py`. Do NOT:
> - reach for `pio device monitor` (needs an interactive TTY, dies through a pipe)
> - write throwaway inline `pyserial`/heredoc snippets (monitor.py already does it)
> - invent your own port reset/baud/parsing logic
>
> If monitor.py is missing a feature you need, **add it to monitor.py**. That is
> the whole point of it existing.
>
> ```sh
> python3 receiver/monitor.py -d 12               # capture 12 s of boot log (resets the board)
> python3 receiver/monitor.py --port /dev/ttyACM0 --no-reset -t   # stream, timestamped, no reset
> python3 receiver/monitor.py --hex -d 30         # show binary startup bytes as hex
> python3 receiver/monitor.py --marker "===== radio probe" -d 95 -o probe.log   # start at a banner, log to file
> ```
>
> It auto-picks the first `ttyACM*`/`ttyUSB*` port, reads `monitor_speed` from
> `platformio.ini`, resets the board into the app on connect, and prints decoded
> lines. Flags: `-q` suppress binary startup bytes, `--hex` show them as hex,
> `-d/--duration` seconds, `-t/--timestamp`, `--no-reset`, `--marker TEXT` start
> printing only after a line containing TEXT, `-o/--output FILE` append to a file.