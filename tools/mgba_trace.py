#!/usr/bin/env python3
"""Capture deterministic frame/state references from mc-virus.gba via mGBA's GDB stub.

The breakpoint is the top of the demo's main frame loop.  Alongside a compact JSON
timeline, optional PNGs are reconstructed from GBA Mode-4 VRAM, palette and OAM.
This is deliberately a development tool: the browser port has no emulator dependency.
"""

from __future__ import annotations

import argparse
import json
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image


ROM_BASE = 0x08000000
FRAME_BREAK = 0x080004E0
FPS = 16_777_216 / 280_896  # GBA master clock / cycles per frame


class RSP:
    def __init__(self, host: str = "127.0.0.1", port: int = 2345):
        self.socket = socket.create_connection((host, port), 3)
        # RSP consists of tiny request/ACK packets.  Without TCP_NODELAY macOS
        # repeatedly hits the delayed-ACK timer, making a trace ~100x slower.
        self.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.socket.settimeout(30)

    def close(self) -> None:
        self.socket.close()

    def _packet(self) -> bytes:
        while True:
            byte = self.socket.recv(1)
            if not byte:
                raise EOFError("mGBA closed the GDB connection")
            if byte == b"$":
                break
        data = bytearray()
        while True:
            byte = self.socket.recv(1)
            if byte == b"#":
                break
            data += byte
        checksum = self.socket.recv(2)
        expected = int(checksum, 16)
        if sum(data) & 0xFF != expected:
            self.socket.sendall(b"-")
            raise RuntimeError("bad RSP checksum")
        self.socket.sendall(b"+")
        return bytes(data)

    def command(self, command: str, wait: bool = True) -> bytes | None:
        payload = command.encode("ascii")
        packet = b"$" + payload + b"#" + f"{sum(payload) & 0xff:02x}".encode("ascii")
        self.socket.sendall(packet)
        if self.socket.recv(1) != b"+":
            raise RuntimeError(f"mGBA rejected RSP command {command!r}")
        return self._packet() if wait else None

    def memory(self, address: int, size: int) -> bytes:
        result = bytearray()
        while size:
            # mGBA 0.10.x caps GDB memory packets at 0x200 bytes.
            chunk = min(size, 0x200)
            reply = self.command(f"m{address:x},{chunk:x}")
            assert reply is not None
            if reply.startswith(b"E"):
                raise RuntimeError(f"memory read failed at {address:#x}: {reply!r}")
            result += bytes.fromhex(reply.decode("ascii"))
            address += chunk
            size -= chunk
        return bytes(result)

    def cont(self) -> bytes:
        self.command("c", wait=False)
        return self._packet()


def u16(data: bytes, offset: int = 0) -> int:
    return struct.unpack_from("<H", data, offset)[0]


def i16(data: bytes, offset: int = 0) -> int:
    return struct.unpack_from("<h", data, offset)[0]


def u32(data: bytes, offset: int = 0) -> int:
    return struct.unpack_from("<I", data, offset)[0]


def rgba555(color: int) -> tuple[int, int, int, int]:
    r = color & 31
    g = color >> 5 & 31
    b = color >> 10 & 31
    return (r << 3 | r >> 2, g << 3 | g >> 2, b << 3 | b >> 2, 255)


SPRITE_SIZES = (
    ((8, 8), (16, 16), (32, 32), (64, 64)),
    ((16, 8), (32, 8), (32, 16), (64, 32)),
    ((8, 16), (8, 32), (16, 32), (32, 64)),
)


def render_mode4(io: bytes, palette: bytes, vram: bytes, oam: bytes) -> Image.Image:
    """Render the subset used by Virus: Mode-4 BG2 plus 1D-mapped OBJ sprites."""
    dispcnt = u16(io, 0)
    if dispcnt & 7 != 4:
        raise ValueError(f"expected Mode 4, got DISPCNT={dispcnt:#06x}")
    page = 0xA000 if dispcnt & 0x10 else 0
    bg_priority = u16(io, 0x0C) & 3
    bg_palette = [rgba555(u16(palette, n * 2)) for n in range(256)]
    obj_palette = [rgba555(u16(palette, 0x200 + n * 2)) for n in range(256)]

    pixels = [bg_palette[vram[page + n]] for n in range(240 * 160)]
    depths = [bg_priority * 256 + 128] * (240 * 160)
    if not dispcnt & 0x1000:
        image = Image.new("RGBA", (240, 160))
        image.putdata(pixels)
        return image

    one_dimensional = bool(dispcnt & 0x40)
    for index in range(127, -1, -1):
        off = index * 8
        attr0, attr1, attr2 = struct.unpack_from("<HHH", oam, off)
        affine = bool(attr0 & 0x0100)
        if not affine and attr0 & 0x0200:
            continue
        shape = attr0 >> 14
        size = attr1 >> 14
        if shape >= 3:
            continue
        width, height = SPRITE_SIZES[shape][size]
        draw_width = width * (2 if affine and attr0 & 0x0200 else 1)
        draw_height = height * (2 if affine and attr0 & 0x0200 else 1)
        x0 = attr1 & 0x1FF
        y0 = attr0 & 0xFF
        if x0 >= 256:
            x0 -= 512
        if y0 >= 160:
            y0 -= 256
        color256 = bool(attr0 & 0x2000)
        tile_base = attr2 & 0x03FF
        priority = attr2 >> 10 & 3
        bank = attr2 >> 12 & 15
        depth = priority * 256 + index
        hflip = bool(attr1 & 0x1000) and not affine
        vflip = bool(attr1 & 0x2000) and not affine

        if affine:
            matrix = attr1 >> 9 & 31
            pa = i16(oam, (matrix * 4 + 0) * 8 + 6)
            pb = i16(oam, (matrix * 4 + 1) * 8 + 6)
            pc = i16(oam, (matrix * 4 + 2) * 8 + 6)
            pd = i16(oam, (matrix * 4 + 3) * 8 + 6)
        else:
            pa, pb, pc, pd = 256, 0, 0, 256

        for dy in range(draw_height):
            sy_screen = y0 + dy
            if sy_screen < 0 or sy_screen >= 160:
                continue
            for dx in range(draw_width):
                sx_screen = x0 + dx
                if sx_screen < 0 or sx_screen >= 240:
                    continue
                if affine:
                    cx = dx - draw_width // 2
                    cy = dy - draw_height // 2
                    tx = ((pa * cx + pb * cy) >> 8) + width // 2
                    ty = ((pc * cx + pd * cy) >> 8) + height // 2
                else:
                    tx = width - 1 - dx if hflip else dx
                    ty = height - 1 - dy if vflip else dy
                if tx < 0 or tx >= width or ty < 0 or ty >= height:
                    continue

                if one_dimensional:
                    units_per_row = width // 8 * (2 if color256 else 1)
                else:
                    units_per_row = 32
                tile = tile_base + ty // 8 * units_per_row + tx // 8 * (2 if color256 else 1)
                tile_address = 0x10000 + tile * 32 + (ty & 7) * (8 if color256 else 4)
                if color256:
                    color_index = vram[tile_address + (tx & 7)]
                    color = obj_palette[color_index]
                else:
                    packed = vram[tile_address + (tx & 7) // 2]
                    color_index = packed >> (4 if tx & 1 else 0) & 15
                    color = obj_palette[bank * 16 + color_index]
                if color_index == 0:
                    continue
                screen_index = sy_screen * 240 + sx_screen
                if depth <= depths[screen_index]:
                    pixels[screen_index] = color
                    depths[screen_index] = depth

    image = Image.new("RGBA", (240, 160))
    image.putdata(pixels)
    return image


def wait_for_stub(process: subprocess.Popen[bytes] | None, port: int) -> RSP:
    deadline = time.monotonic() + 10
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise RuntimeError(f"mGBA exited with status {process.returncode}")
        try:
            return RSP(port=port)
        except OSError as error:
            last_error = error
            time.sleep(0.05)
    raise RuntimeError(f"mGBA GDB stub did not open: {last_error}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rom", type=Path, default=Path("mc-virus.gba"))
    parser.add_argument("--mgba", type=Path,
                        default=Path("/Applications/mGBA.app/Contents/MacOS/mGBA"))
    parser.add_argument("--attach", action="store_true", help="connect to an existing stub")
    parser.add_argument("--port", type=int, default=2345)
    parser.add_argument("--frames", type=int, default=12_200)
    parser.add_argument("--every", type=int, default=60, help="PNG sampling interval")
    parser.add_argument("--out", type=Path, default=Path("/tmp/mcvirus-trace"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    process: subprocess.Popen[bytes] | None = None
    if not args.attach:
        process = subprocess.Popen(
            [str(args.mgba), "-g", "-C", "pauseOnFocusLost=0", "-C", "audioSync=0",
             "-C", "videoSync=0", "-C", "mute=1", str(args.rom.resolve())],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

    rsp = wait_for_stub(process, args.port)
    timeline: list[dict[str, int | float]] = []
    try:
        rsp.command("qSupported")
        if rsp.command(f"Z0,{FRAME_BREAK:08x},4") != b"OK":
            raise RuntimeError("could not install frame-loop breakpoint")
        for frame in range(args.frames):
            stop = rsp.cont()
            if not stop.startswith((b"S05", b"T05")):
                raise RuntimeError(f"unexpected stop at frame {frame}: {stop!r}")

            globals_ = rsp.memory(0x030050D0, 0x1C0)
            counters = rsp.memory(0x03005880, 0x10)
            io = rsp.memory(0x04000000, 0x60)
            entry = {
                "frame": frame,
                "seconds": frame / FPS,
                "counter": u32(counters, 0),
                "previous_part": u32(counters, 4),
                "part": u32(globals_, 4),
                "part_frame": u32(globals_, 0x1BC),
                "dispcnt": u16(io, 0),
            }
            timeline.append(entry)

            if args.every > 0 and frame % args.every == 0:
                # mGBA exposes BG and OBJ palette RAM as distinct GDB regions.
                palette = (rsp.memory(0x05000000, 0x200) +
                           rsp.memory(0x05000200, 0x200))
                vram = rsp.memory(0x06000000, 0x18000)
                oam = rsp.memory(0x07000000, 0x400)
                render_mode4(io, palette, vram, oam).save(args.out / f"frame-{frame:05d}.png")
            if frame % 600 == 0:
                print(f"{frame:5d}  {entry['seconds']:7.2f}s  part={entry['part']:2d} "
                      f"counter={entry['counter']}", flush=True)

        rsp.command(f"z0,{FRAME_BREAK:08x},4")
    finally:
        (args.out / "timeline.json").write_text(json.dumps(timeline, indent=2) + "\n")
        rsp.close()
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
    return 0


if __name__ == "__main__":
    sys.exit(main())
