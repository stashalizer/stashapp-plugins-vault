#!/usr/bin/env python3
"""Builds the Carbon Arc CJK faces from IBM Plex Sans SC.

NOT part of the site build and not needed to ship a change: the woff2 files it
produces are committed. Run it only when the subset or the source font changes.

    python -m pip install fonttools brotli
    python scripts/build_cjk_fonts.py path/to/IBMPlexSansSC-Regular.woff2 \
        path/to/IBMPlexSansSC-Medium.woff2 path/to/IBMPlexSansSC-SemiBold.woff2

Source: @ibm/plex-sans-sc 1.1.0 (npm, `fonts/complete/woff2/hinted/`), SIL OFL
1.1. IBM's licence carries the Reserved Font Name "Plex" and a subset is a
modification, so the output is renamed to "Carbon Arc Sans CJK" — the licence
keeps the licence, not the name. fonts/OFL.txt travels with the result.

Character set: everything in GB2312 (6,763 hanzi plus its kana, Greek, Cyrillic
and pinyin rows), plus CJK punctuation, full-width forms and a few marks GB2312
lacks — 7,496 characters, about 0.85 MB per weight.
"""

import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

FAMILY = "Carbon Arc Sans CJK"
STYLES = {"Regular": 400, "Medium": 500, "SemiBold": 600}


def characters():
    chars = set()
    for high in range(0xA1, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                chars.add(bytes([high, low]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    for low, high in ((0x3000, 0x303F), (0xFF01, 0xFF60), (0xFFE0, 0xFFE6)):
        chars.update(chr(cp) for cp in range(low, high + 1))
    chars.update("々〆〇・ー〜～…‥‘’“”")
    return "".join(sorted(chars))


def rename(font, style, weight):
    names = {
        1: FAMILY,
        2: style,
        3: f"CarbonArcSansCJK-{style}; subset of IBM Plex Sans SC 1.1.0 (SIL OFL 1.1)",
        4: f"{FAMILY} {style}",
        6: f"CarbonArcSansCJK-{style}",
    }
    table = font["name"]
    for record in list(table.names):
        if record.nameID in (16, 17):
            table.names.remove(record)
        elif record.nameID in names:
            table.setName(names[record.nameID], record.nameID, record.platformID,
                          record.platEncID, record.langID)
    font["OS/2"].usWeightClass = weight


def normalize_metrics(font):
    """Match IBM Plex Sans's 1025/-275/0.

    The source sits at 880/-120 with a 1000 line gap. Left alone, a line
    containing Chinese is a different height from a Latin one and a mixed
    paragraph gains two leadings. USE_TYPO_METRICS makes every engine agree
    that the OS/2 typo numbers are the ones to use.
    """
    font["hhea"].ascent = 1025
    font["hhea"].descent = -275
    font["hhea"].lineGap = 0
    os2 = font["OS/2"]
    os2.sTypoAscender = 1025
    os2.sTypoDescender = -275
    os2.sTypoLineGap = 0
    os2.fsSelection |= 1 << 7


def main():
    out_dir = Path(__file__).resolve().parent.parent / "plugins" / "CarbonArc" / "fonts"
    text = characters()
    print(f"subsetting to {len(text)} characters")

    for source in sys.argv[1:]:
        style = next((s for s in STYLES if s.lower() in Path(source).stem.lower()), None)
        if style is None:
            sys.exit(f"cannot tell the weight of {source}")

        options = subset.Options()
        options.flavor = "woff2"
        options.layout_features = ["kern", "vert", "vrt2", "ccmp", "locl", "liga", "clig", "calt"]
        options.name_IDs = ["*"]
        options.name_legacy = True
        options.notdef_outline = True
        options.drop_tables += ["DSIG"]
        options.desubroutinize = True

        font = TTFont(source)
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(text=text)
        subsetter.subset(font)
        rename(font, style, STYLES[style])
        normalize_metrics(font)

        target = out_dir / f"carbon-arc-sans-cjk-{style.lower()}.woff2"
        font.save(target)
        print(f"  {style:9s} {target.name}  {target.stat().st_size / 1048576:.2f} MB")


if __name__ == "__main__":
    main()
