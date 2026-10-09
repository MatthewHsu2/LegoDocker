"""Give every order a draft category, from its cluster and cluster_map.csv.

Usage: python categorize.py
Reads data/orders.csv, data/clusters.csv, data/error_codes.csv, cluster_map.csv.
Writes data/issue_categories.csv and prints how many orders fall in each category.

cluster_map.csv matches one run of `cluster.py 80`. Rerun cluster.py with another k and the
map no longer fits.
"""

import csv
import re
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE / "data"

OUT_OF_BOX = re.compile(r"\boob|oob\b|\bo\.o\.b\b|out[ -]of[ -](?:the )?box", re.IGNORECASE)


def is_out_of_box(issue):
    return bool(OUT_OF_BOX.search(issue))


def read(path, key, value):
    with open(path, newline="") as f:
        return {r[key]: r[value] for r in csv.DictReader(f)}


def main():
    csv.field_size_limit(sys.maxsize)
    category_of = read(HERE / "cluster_map.csv", "Cluster", "Category")
    cluster_of = read(DATA / "clusters.csv", "Id", "Cluster")
    codes_of = read(DATA / "error_codes.csv", "Id", "ErrorCodes")

    counts = Counter()
    with open(DATA / "orders.csv", newline="") as f, open(DATA / "issue_categories.csv", "w", newline="") as g:
        w = csv.writer(g)
        w.writerow(["Id", "OrderDate", "Category", "ErrorCodes", "OutOfBox", "OldTags", "Cluster", "Issue", "Solution"])
        for o in csv.DictReader(f):
            cluster = cluster_of[o["Id"]]
            category = category_of[cluster]
            counts[category] += 1
            w.writerow([o["Id"], o["OrderDate"][:10], category, codes_of.get(o["Id"], ""),
                        "yes" if is_out_of_box(o["Issue"]) else "no", o["OldTags"], cluster, o["Issue"], o["Solution"]])

    total = sum(counts.values())
    print(f"wrote {DATA / 'issue_categories.csv'}")
    for category, n in counts.most_common():
        print(f"{n:7}  {100 * n / total:4.1f}%  {category}")


if __name__ == "__main__":
    main()
