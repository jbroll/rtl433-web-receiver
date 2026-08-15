#!/usr/bin/env python3
"""Headless serial monitor for the receiver.

PlatformIO's `pio device monitor` needs an interactive terminal (termios), so it
fails when run through a pipe or from non-interactive automation. This script
reads the same port with the same defaults, but works headlessly.
"""

import argparse
import contextlib
import glob
import os
import re
import sys
import time

import serial


def default_port():
    """Return the first likely USB serial port, or None."""
    for pattern in ("/dev/ttyACM*", "/dev/ttyUSB*", "/dev/tty.usbserial*"):
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[0]
    return None


def default_baud():
    """Read monitor_speed from platformio.ini if present."""
    path = os.path.join(os.path.dirname(__file__), "platformio.ini")
    try:
        with open(path) as handle:
            for line in handle:
                match = re.match(r"^monitor_speed\s*=\s*(\d+)", line)
                if match:
                    return int(match.group(1))
    except OSError:
        pass
    return 921600


def reset_board(port):
    """Pulse RTS to reset an ESP32-S3 (active low).

    DTR is held low so the board resets into the application, not the download
    bootloader.
    """
    port.setDTR(False)
    port.setRTS(False)
    time.sleep(0.05)
    port.setRTS(True)
    time.sleep(0.1)
    port.setRTS(False)
    time.sleep(0.5)


def main():
    parser = argparse.ArgumentParser(
        description="Headless serial monitor for the rtl433-web-receiver."
    )
    parser.add_argument(
        "--port",
        default=default_port(),
        help="Serial port (default: first USB serial device)",
    )
    parser.add_argument(
        "--baud",
        type=int,
        default=default_baud(),
        help="Baud rate (default: from platformio.ini)",
    )
    parser.add_argument(
        "--duration",
        "-d",
        type=float,
        default=0,
        help="Seconds to run; 0 runs until interrupted",
    )
    parser.add_argument(
        "--reset",
        "-r",
        action="store_true",
        default=True,
        help="Reset the board on connect (default)",
    )
    parser.add_argument(
        "--no-reset",
        action="store_true",
        help="Do not reset the board on connect",
    )
    parser.add_argument(
        "--timestamp",
        "-t",
        action="store_true",
        help="Prefix each line with a timestamp",
    )
    parser.add_argument(
        "--quiet",
        "-q",
        action="store_true",
        help="Suppress non-printable startup bytes",
    )
    args = parser.parse_args()

    if not args.port:
        print("error: no serial port found", file=sys.stderr)
        sys.exit(1)

    with contextlib.closing(serial.Serial(args.port, args.baud, timeout=0.1)) as port:
        if not args.no_reset:
            reset_board(port)

        start = time.time()
        line_buffer = b""
        while True:
            if args.duration and time.time() - start >= args.duration:
                break
            chunk = port.read(1024)
            if not chunk:
                continue

            lines = (line_buffer + chunk).split(b"\n")
            line_buffer = lines.pop()
            for line in lines:
                line = line.rstrip(b"\r")
                if args.quiet and not all(32 <= b <= 126 or b in (9, 10, 13) for b in line):
                    continue
                decoded = line.decode("utf-8", errors="replace")
                if args.timestamp:
                    decoded = f"{time.strftime('%H:%M:%S')} {decoded}"
                print(decoded)
                sys.stdout.flush()


if __name__ == "__main__":
    main()
