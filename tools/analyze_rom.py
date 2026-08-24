#!/usr/bin/env python3
"""Reproduce the mc-virus asset manifest and Krawall sync timeline.

The ROM does not use a filesystem or a standard GBA header.  Its content
archive starts at 0x00cd28 and its Krawall song root is at 0x226aec.  This
script documents both layouts and emits stable, diffable reports.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from struct import unpack_from

MODULE = 0x226AEC
DIRECTORY = 0x17F888
DATA_BASE = 0x00CD28
SAMPLE_RATE = 32768
CPU_CYCLES_PER_SAMPLE = 512
CPU_CYCLES_PER_VBLANK = 280896
SAMPLES_PER_VBLANK = CPU_CYCLES_PER_VBLANK / CPU_CYCLES_PER_SAMPLE


@dataclass(frozen=True)
class Asset:
    name: str
    offset: int
    size: int


@dataclass(frozen=True)
class Marker:
    order: int
    pattern: int
    row: int
    global_row: int
    channel: int
    value: int
    sample: int


@dataclass(frozen=True)
class SongInfo:
    channels: int
    orders: tuple[int, ...]
    restart: int
    global_volume: int
    speed: int
    bpm_field: int
    flags: tuple[int, ...]
    pattern_count: int
    total_rows: int
    tick_samples: int
    row_samples: int
    markers: tuple[Marker, ...]


def read_assets(rom: bytes) -> list[Asset]:
    directory_length = unpack_from("<I", rom, DIRECTORY)[0]
    end = DIRECTORY + directory_length
    cursor = DIRECTORY + 4
    raw: list[tuple[int, str]] = []
    while cursor < end:
        offset = unpack_from("<I", rom, cursor)[0]
        cursor += 4
        nul = rom.index(0, cursor, end + 1)
        raw.append((offset, rom[cursor:nul].decode("ascii")))
        cursor = nul + 1
    assets = []
    for index, (offset, name) in enumerate(raw):
        next_offset = raw[index + 1][0] if index + 1 < len(raw) else DIRECTORY - DATA_BASE
        assets.append(Asset(name, offset, next_offset - offset))
    return assets


def read_song(rom: bytes) -> SongInfo:
    channels, order_count, restart = rom[MODULE:MODULE + 3]
    orders = tuple(rom[MODULE + 3:MODULE + 3 + order_count])
    volume, speed, bpm = rom[MODULE + 355:MODULE + 358]
    flags = tuple(rom[MODULE + 358:MODULE + 364])
    max_pattern = max(value for value in orders if value < 254)
    pointers = [
        unpack_from("<I", rom, MODULE + 364 + 4 * index)[0] & 0x1FFFFFF
        for index in range(max_pattern + 1)
    ]

    patterns = []
    for offset in pointers:
        rows = unpack_from("<H", rom, offset + 32)[0]
        cursor = offset + 34
        row_events = []
        for _row in range(rows):
            events = []
            while True:
                follow = rom[cursor]
                cursor += 1
                if follow == 0:
                    break
                channel = follow & 0x1F
                if follow & 0x20:
                    note, instrument = rom[cursor:cursor + 2]
                    cursor += 2
                    if note & 0x80:
                        instrument |= rom[cursor] << 8
                        cursor += 1
                if follow & 0x40:
                    cursor += 1
                effect = operand = None
                if follow & 0x80:
                    effect, operand = rom[cursor:cursor + 2]
                    cursor += 2
                events.append((channel, effect, operand))
            row_events.append(events)
        patterns.append(row_events)

    # Krawall truncates first, then aligns to a four-sample mixer quantum.
    tick_samples = ((15 * SAMPLE_RATE) // (24 * bpm)) * 4
    row_samples = tick_samples * speed
    markers = []
    global_row = 0
    for order, pattern in enumerate(orders):
        if pattern >= 254:
            continue
        for row, events in enumerate(patterns[pattern]):
            for channel, effect, operand in events:
                if effect == 36 and operand is not None:  # Krawall Zxx / MARK
                    marker_row = global_row + row
                    sample = tick_samples + marker_row * row_samples
                    markers.append(Marker(order, pattern, row, marker_row, channel, operand, sample))
        global_row += len(patterns[pattern])

    return SongInfo(
        channels, orders, restart, volume, speed, bpm, flags, len(patterns),
        global_row, tick_samples, row_samples, tuple(markers)
    )


def marker_semantics(value: int) -> str:
    if value == 0:
        return "beat: beat_count++; beat_frame=part_vblank"
    if 0x10 <= value <= 0x1F:
        return f"cue10={value - 0x10}; cue10_frame=part_vblank"
    if 0x20 <= value <= 0x2F:
        return f"cue20={value - 0x20}"
    if 0xC0 <= value <= 0xCF:
        return f"subpart={value - 0xC0}; subpart_vblank=0"
    if value >= 0xF0:
        return f"part={value - 0xF0}; part_vblank=0; aux_part_vblank=0"
    return "unclassified"


def sync_report(song: SongInfo) -> str:
    first_part = next(marker.sample for marker in song.markers if marker.value >= 0xF0)
    lines = [
        "MC-VIRUS Krawall module and sync timeline",
        f"ROM module root: 0x{MODULE:06X}",
        f"channels={song.channels} orders={len(song.orders)} restart={song.restart} patterns={song.pattern_count}",
        f"order={list(song.orders)}",
        f"global_volume={song.global_volume} speed={song.speed} BPM_field={song.bpm_field} flags={list(song.flags)}",
        f"sample_rate={SAMPLE_RATE}; tick_samples={song.tick_samples}; row_samples={song.row_samples}",
        f"tick_seconds={song.tick_samples / SAMPLE_RATE:.12f}; row_seconds={song.row_samples / SAMPLE_RATE:.12f}",
        f"effective_BPM={2.5 / (song.tick_samples / SAMPLE_RATE):.12f}",
        "No speed, tempo, jump, break, loop, or pattern-delay effects occur.",
        "",
        "PART TRANSITIONS",
        "part\torder\tpattern\trow\tglobal_row\tsample_from_krapPlay\tsec_from_krapPlay\tsec_from_first_part\tvblank_equiv_from_krapPlay\tvblank_equiv_from_first_part",
    ]
    for marker in song.markers:
        if marker.value < 0xF0:
            continue
        lines.append("\t".join(map(str, [
            marker.value - 0xF0, marker.order, marker.pattern, marker.row,
            marker.global_row, marker.sample, f"{marker.sample / SAMPLE_RATE:.9f}",
            f"{(marker.sample - first_part) / SAMPLE_RATE:.9f}",
            f"{marker.sample / SAMPLES_PER_VBLANK:.6f}",
            f"{(marker.sample - first_part) / SAMPLES_PER_VBLANK:.6f}",
        ])))
    final_sample = song.tick_samples + (song.total_rows - 1) * song.row_samples
    lines.extend([
        "",
        f"total_rows={song.total_rows}",
        f"Krawall processes final row/stops channels at sample={final_sample}, t={final_sample / SAMPLE_RATE:.9f}s",
        "",
        "ALL RAW Zxx MARKERS (callback order)",
        "order\tpattern\trow\tglobal_row\tchannel\tZxx\tsample_from_krapPlay\tsec_from_krapPlay\tvblank_equiv\tsemantics",
    ])
    for marker in song.markers:
        lines.append("\t".join(map(str, [
            marker.order, marker.pattern, marker.row, marker.global_row,
            marker.channel, f"Z{marker.value:02X}", marker.sample,
            f"{marker.sample / SAMPLE_RATE:.9f}",
            f"{marker.sample / SAMPLES_PER_VBLANK:.6f}", marker_semantics(marker.value),
        ])))
    return "\n".join(lines) + "\n"


def asset_report(rom: bytes, assets: list[Asset]) -> str:
    length = unpack_from("<I", rom, DIRECTORY)[0]
    lines = ["index\tname\trelative_offset\trom_offset\tsize"]
    for index, asset in enumerate(assets):
        lines.append(
            f"{index}\t{asset.name}\t0x{asset.offset:06X}\t"
            f"0x{DATA_BASE + asset.offset:06X}\t0x{asset.size:X}"
        )
    lines.extend([
        "", f"entry_count={len(assets)}", f"data_base=0x{DATA_BASE:06X}",
        f"directory=0x{DIRECTORY:06X}", f"directory_length=0x{length:X}",
        f"directory_end=0x{DIRECTORY + length:06X}",
    ])
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("rom", nargs="?", type=Path, default=Path("mc-virus.gba"))
    parser.add_argument("--out", type=Path, default=Path("notes"))
    args = parser.parse_args()
    rom = args.rom.read_bytes()
    assets = read_assets(rom)
    song = read_song(rom)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "ASSET_MANIFEST.tsv").write_text(asset_report(rom, assets))
    (args.out / "SYNC_TIMELINE.tsv").write_text(sync_report(song))
    print(f"wrote {len(assets)} assets and {len(song.markers)} sync markers to {args.out}")


if __name__ == "__main__":
    main()
