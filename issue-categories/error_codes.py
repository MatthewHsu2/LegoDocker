"""Find machine error codes (E5, E50H, LS1, ...) in free-text Issue and Solution notes.

Usage: python error_codes.py   reads data/orders.csv, writes data/error_codes.csv
"""

import csv
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent

# Sole elliptical model names look like error codes: "my E95 elliptical", "console for an E35".
MODEL_NUMBERS = {"15", "20", "25", "35", "55", "75", "95", "98"}

# E5, e-5, E 5, E05, E50H, E10-H, and E5 glued to the next word (E5oob, E5error).
E_CODE = re.compile(
    r"(?<![A-Za-z0-9])E[ -]?(?P<num>\d{1,3})(?![0-9])(?P<h>[ -]?H(?![A-Za-z]))?",
    re.IGNORECASE,
)

# "ERROR 5", "ERR-6", but not "LS ERROR 30 MINUTES INTO..." or the typo "ERR0R".
ERROR_N = re.compile(
    r"(?<![A-Za-z0-9])ERR(?:OR)?[ -]?(?P<num>\d{1,2})(?![A-Za-z0-9])"
    r"(?! ?(?:MIN|SEC|MILE|HOUR|HR)S?\b|\s*(?:MINUTES?|SECONDS?|MILES?|HOURS?)\b)",
    re.IGNORECASE,
)

# Low-speed errors: LS, LS1, LS 2, and LSI (a common typo of LS1).
LS_CODE = re.compile(
    r"(?<![A-Za-z0-9])LS(?:(?P<num>[ -]?[12])(?![0-9])|(?P<i>I))?(?![A-Za-z0-9])",
    re.IGNORECASE,
)
LOW_SPEED_ERROR = re.compile(r"\blow ?speed error\b", re.IGNORECASE)

ERROR_WORD_NEAR = re.compile(r"^.{0,12}\b(?:error|err|code)\b", re.IGNORECASE)


def _num(digits):
    return str(int(digits))


def extract(text):
    """Return the sorted, unique error codes in one piece of text."""
    if not text:
        return []
    codes = set()

    for m in E_CODE.finditer(text):
        num, has_h = m.group("num"), bool(m.group("h"))
        if not has_h and num in MODEL_NUMBERS and not ERROR_WORD_NEAR.match(text[m.end():]):
            continue
        codes.add("E" + _num(num) + ("H" if has_h else ""))

    for m in ERROR_N.finditer(text):
        codes.add("E" + _num(m.group("num")))

    for m in LS_CODE.finditer(text):
        if m.group("i"):
            codes.add("LS1")
        elif m.group("num"):
            codes.add("LS" + m.group("num").strip(" -"))
        else:
            codes.add("LS")

    if LOW_SPEED_ERROR.search(text):
        codes.add("LS")

    return sorted(codes, key=lambda c: (re.sub(r"\d.*", "", c), int(re.sub(r"\D", "", c) or -1), c))


def main():
    csv.field_size_limit(sys.maxsize)
    src = HERE / "data" / "orders.csv"
    out = HERE / "data" / "error_codes.csv"
    counts = Counter()
    with open(src, newline="") as f, open(out, "w", newline="") as g:
        w = csv.writer(g)
        w.writerow(["Id", "ErrorCodes"])
        for row in csv.DictReader(f):
            codes = extract(row["Issue"] + "\n" + row["Solution"])
            if codes:
                w.writerow([row["Id"], ";".join(codes)])
                counts.update(codes)
    print(f"wrote {out}: {sum(1 for _ in open(out)) - 1} orders with a code")
    for code, n in counts.most_common(30):
        print(f"{n:7} {code}")


if __name__ == "__main__":
    main()
