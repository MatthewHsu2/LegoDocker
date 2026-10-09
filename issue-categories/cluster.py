"""Group similar Issue texts so a person can name the groups.

Usage: python cluster.py [k]
Reads data/orders.csv and data/error_codes.csv.
Writes data/clusters.csv (Id -> cluster) and data/clusters.md (one section per cluster, to read).
"""

import csv
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
DATA = HERE / "data"
MODEL = "BAAI/bge-small-en-v1.5"

# Words about who reported the problem, not what the problem is.
REPORTER_NOISE = re.compile(
    r"^\s*(?:other|gen\. help)\s*,"
    r"|\*\*email from customer\*\*"
    r"|\b(?:sent|emailed?) (?:an )?email(?: stating(?: that)?)?\b"
    r"|\b(?:tech|technician|customer|cust|dealer)(?: called(?: in)?| emailed| states?| stated)(?: that)?\b"
    r"|\bper (?:the )?(?:tech|technician|customer|cust|dealer|service co)(?: onsite| feedback)?\b",
    re.IGNORECASE,
)


def clean(text):
    text = REPORTER_NOISE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip(" ,.-").lower()


def main():
    k = int(sys.argv[1]) if len(sys.argv) > 1 else 80
    csv.field_size_limit(sys.maxsize)
    with open(DATA / "orders.csv", newline="") as f:
        orders = list(csv.DictReader(f))
    with open(DATA / "error_codes.csv", newline="") as f:
        codes = {r["Id"]: r["ErrorCodes"] for r in csv.DictReader(f)}

    ids_by_text = defaultdict(list)
    for o in orders:
        ids_by_text[clean(o["Issue"])].append(o["Id"])
    texts = list(ids_by_text)
    weights = np.array([len(ids_by_text[t]) for t in texts], dtype=np.float32)
    print(f"{len(orders)} orders, {len(texts)} unique cleaned texts")

    emb_file = DATA / f"embeddings-{MODEL.replace('/', '_')}.npy"
    texts_file = DATA / "embedded_texts.txt"
    if emb_file.exists() and texts_file.read_text().split("\n\x00\n") == texts:
        emb = np.load(emb_file)
    else:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(MODEL, device="cuda")
        model.max_seq_length = 128
        emb = model.encode(texts, batch_size=512, normalize_embeddings=True, show_progress_bar=True)
        np.save(emb_file, emb)
        texts_file.write_text("\n\x00\n".join(texts))

    from sklearn.cluster import MiniBatchKMeans

    km = MiniBatchKMeans(n_clusters=k, random_state=0, batch_size=8192, n_init=5)
    labels = km.fit_predict(emb, sample_weight=weights)
    dist = np.linalg.norm(emb - km.cluster_centers_[labels], axis=1)

    by_order = {o["Id"]: o for o in orders}
    with open(DATA / "clusters.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Id", "Cluster"])
        for t, c in zip(texts, labels):
            for i in ids_by_text[t]:
                w.writerow([i, int(c)])

    rnd = random.Random(0)
    total = len(orders)
    sizes = Counter()
    for t, c in zip(texts, labels):
        sizes[int(c)] += len(ids_by_text[t])

    lines = [f"# {k} clusters over {total} orders\n"]
    for c, n in sizes.most_common():
        members = [i for i in np.where(labels == c)[0]]
        central = sorted(members, key=lambda i: dist[i])[:8]
        frequent = sorted(members, key=lambda i: -weights[i])[:6]
        sample = rnd.sample(members, min(8, len(members)))
        ids = [i for m in members for i in ids_by_text[texts[m]]]
        tags = Counter(t.strip() for i in ids for t in by_order[i]["OldTags"].split(";") if t.strip())
        errs = Counter(e for i in ids for e in codes.get(i, "").split(";") if e)
        lines.append(f"\n## Cluster {c} — {n} orders ({100 * n / total:.1f}%)\n")
        lines.append("Old tags: " + ", ".join(f"{t} {100 * m / n:.0f}%" for t, m in tags.most_common(4)))
        lines.append("Error codes: " + ", ".join(f"{e} {m}" for e, m in errs.most_common(5)))
        lines.append("\nCentral:")
        lines += [f"- {texts[i][:160]}" for i in central]
        lines.append("\nMost frequent:")
        lines += [f"- ({int(weights[i])}x) {texts[i][:160]}" for i in frequent]
        lines.append("\nRandom:")
        lines += [f"- {texts[i][:160]}" for i in sample]
    (DATA / "clusters.md").write_text("\n".join(lines) + "\n")
    print(f"wrote {DATA / 'clusters.csv'} and {DATA / 'clusters.md'}")


if __name__ == "__main__":
    main()
