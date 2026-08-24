#!/usr/bin/env python3
"""Extract Virus's converted Krawall bank and module without tracker conversion.

The ROM does not contain the source XM.  It contains the compact structures
consumed by Krawall 2005.  This writes UnkrawerterGBA's lossless KRWB/KRWM
container forms using only Python's standard library.
"""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
from struct import pack, unpack_from


EXPECTED_ROM_SHA256 = "8f799c712b14938c08f956f81729704f7a687cee1c4bc151aaedd83d5cdfa03f"
EXPECTED_BANK_SHA256 = "c8fae5159b443bec48cf14ce6af321c05c39257a3b68cd4b12a349966e108af2"
EXPECTED_MODULE_SHA256 = "629b965d5f754e43366c43ac4eb31c1b4d968036380f6b5935f6c975c761b5c9"

SAMPLE_POINTERS = 0x21E7A8
INSTRUMENT_POINTERS = 0x220E28
MODULE = 0x226AEC

SAMPLE_COUNT = 32
INSTRUMENT_COUNT = 32
INSTRUMENT_SIZE = 302
MODULE_HEADER_SIZE = 364
ROM_POINTER_MASK = 0x01FFFFFF
SAMPLE_GUARD_SIZE = 17 * 4 + 1


def rom_offset(pointer: int) -> int:
    return pointer & ROM_POINTER_MASK


def pointers_at(rom: bytes, offset: int, count: int) -> list[int]:
    return [
        rom_offset(unpack_from("<I", rom, offset + index * 4)[0])
        for index in range(count)
    ]


def pattern_end(rom: bytes, offset: int) -> int:
    rows = unpack_from("<H", rom, offset + 32)[0]
    cursor = offset + 34
    for _ in range(rows):
        while True:
            follow = rom[cursor]
            cursor += 1
            if follow == 0:
                break
            if follow & 0x20:
                note = rom[cursor]
                cursor += 2
                if note & 0x80:
                    cursor += 1
            if follow & 0x40:
                cursor += 1
            if follow & 0x80:
                cursor += 2
    return cursor


def extract_bank(rom: bytes) -> bytes:
    instrument_offsets = pointers_at(
        rom, INSTRUMENT_POINTERS, INSTRUMENT_COUNT
    )
    sample_offsets = pointers_at(rom, SAMPLE_POINTERS, SAMPLE_COUNT)

    output = bytearray(b"KRWB")
    output += pack("<HH", INSTRUMENT_COUNT, SAMPLE_COUNT)
    pointer_table = len(output)
    output += bytes(4 * (INSTRUMENT_COUNT + SAMPLE_COUNT))

    for index, source in enumerate(instrument_offsets):
        output[pointer_table + index * 4:pointer_table + index * 4 + 4] = pack(
            "<I", len(output)
        )
        output += rom[source:source + INSTRUMENT_SIZE]

    sample_table = pointer_table + 4 * INSTRUMENT_COUNT
    for index, source in enumerate(sample_offsets):
        destination = len(output)
        output[sample_table + index * 4:sample_table + index * 4 + 4] = pack(
            "<I", destination
        )

        # Sample.end remains the logical PCM endpoint.  The physical record
        # also retains Krawall's 69-byte mixer-overread guard; the following
        # entry in the bank pointer table delimits it.  Krawerter reserves
        # 17*4+1 bytes because an aligned four-output mix can advance as many
        # as 17 source bytes per output.  UnkrawerterGBA 4.0's direct-rip
        # writer accidentally absorbs the first 18 guard bytes into end,
        # moving the loop start.  Keeping the two boundaries distinct also
        # round-trips through its reader to the direct-ROM reconstructed XM.
        source_end = rom_offset(unpack_from("<I", rom, source + 4)[0])
        header = bytearray(rom[source:source + 18])
        header[4:8] = pack("<I", destination + source_end - source)
        output += header
        output += rom[source + 18:source_end + SAMPLE_GUARD_SIZE]

    return bytes(output)


def extract_module(rom: bytes) -> bytes:
    header = rom[MODULE:MODULE + MODULE_HEADER_SIZE]
    orders = header[3:3 + header[1]]
    pattern_count = max(order for order in orders if order < 254) + 1
    pattern_offsets = pointers_at(
        rom, MODULE + MODULE_HEADER_SIZE, pattern_count
    )

    output = bytearray(b"KRWM")
    output += header
    pointer_table = len(output)
    output += bytes(4 * pattern_count)

    for index, source in enumerate(pattern_offsets):
        output[pointer_table + index * 4:pointer_table + index * 4 + 4] = pack(
            "<I", len(output)
        )
        output += rom[source:pattern_end(rom, source)]

    return bytes(output)


def extract_runtime_assets(rom: bytes) -> tuple[bytes, bytes]:
    """Return the validated guard-preserving bank and exact module."""
    digest = hashlib.sha256(rom).hexdigest()
    if digest != EXPECTED_ROM_SHA256:
        raise ValueError(
            f"unsupported ROM: SHA-256 is {digest}, expected {EXPECTED_ROM_SHA256}"
        )

    bank = extract_bank(rom)
    module = extract_module(rom)
    bank_digest = hashlib.sha256(bank).hexdigest()
    module_digest = hashlib.sha256(module).hexdigest()
    if bank_digest != EXPECTED_BANK_SHA256:
        raise ValueError(f"internal error: unexpected bank SHA-256 {bank_digest}")
    if module_digest != EXPECTED_MODULE_SHA256:
        raise ValueError(f"internal error: unexpected module SHA-256 {module_digest}")
    return bank, module


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "rom", nargs="?", type=Path, default=Path("mc-virus.gba"),
        help="analyzed Virus GBA ROM (default: mc-virus.gba)",
    )
    parser.add_argument(
        "--out", type=Path, default=Path("."),
        help="output directory for mc-virus.gba.krb and Module0.krw",
    )
    args = parser.parse_args()

    try:
        bank, module = extract_runtime_assets(args.rom.read_bytes())
    except ValueError as error:
        raise SystemExit(str(error)) from error
    bank_digest = hashlib.sha256(bank).hexdigest()
    module_digest = hashlib.sha256(module).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)

    bank_path = args.out / f"{args.rom.name}.krb"
    module_path = args.out / "Module0.krw"
    bank_path.write_bytes(bank)
    module_path.write_bytes(module)
    print(f"wrote {bank_path} ({len(bank)} bytes, SHA-256 {bank_digest})")
    print(f"wrote {module_path} ({len(module)} bytes, SHA-256 {module_digest})")


if __name__ == "__main__":
    main()
