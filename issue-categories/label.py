"""Label Issue texts with 1-3 categories from categories.csv, and keep the labels in files.

Two kinds of label:
- hand labels: Claude Code agents read work files and write answers (labels.jsonl).
- predicted labels: a classifier trained on the hand labels and the text embeddings
  labels everything else (predicted.jsonl). Hand labels always win.

Every command can be stopped and run again. A text gets a work file only when it has no
hand label and is not in an open work file, so new orders (after a new pull.py) are picked
up by the next run.

Usage:
  python label.py status
  python label.py next --size N [--parts K] [--uncertain]  write work files for agents
  python label.py collect                                   save the answers of finished work files
  python label.py release NAME                              give up an open work file
  python label.py predict                                   train on hand labels, label the rest
  python label.py export                                    write data/order_labels.parquet
"""

import argparse
import csv
import hashlib
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from categorize import is_out_of_box
from cluster import MODEL as EMBEDDING_MODEL, clean

HERE = Path(__file__).parent
DATA = HERE / "data"
LABELS = DATA / "labels"
LABELS_FILE = LABELS / "labels.jsonl"
PREDICTED_FILE = LABELS / "predicted.jsonl"
WORK = LABELS / "work"
PENDING = LABELS / "pending"
DONE = LABELS / "done"
ORDER_INDEX = LABELS / "order_index.csv"
EMBEDDINGS = DATA / f"embeddings-{EMBEDDING_MODEL.replace('/', '_')}.npy"
EMBEDDED_TEXTS = DATA / "embedded_texts.txt"

NO_PROBLEM = {"Parts order only", "Tech visit requested", "No issue text"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def key_of(text):
    return hashlib.sha1(text.encode()).hexdigest()[:16]


def read_categories():
    with open(HERE / "categories.csv", newline="") as f:
        return [(r["Category"], r["Meaning"]) for r in csv.DictReader(f)]


def read_orders():
    csv.field_size_limit(sys.maxsize)
    with open(DATA / "orders.csv", newline="") as f:
        return list(csv.DictReader(f))


def unique_texts(orders):
    """Return {key: [cleaned text, number of orders]}."""
    texts = {}
    for o in orders:
        text = clean(o["Issue"])
        texts.setdefault(key_of(text), [text, 0])[1] += 1
    return texts


def read_jsonl(path):
    if not path.exists():
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def hand_labels():
    """{key: categories}; a later line for the same key wins."""
    return {r["key"]: r["categories"] for r in read_jsonl(LABELS_FILE)}


def pending_keys():
    keys = set()
    for path in PENDING.glob("*.json"):
        keys.update(json.loads(path.read_text())["keys"])
    return keys


def tidy(categories, names):
    """Keep known names, at most 3, and never mix a no-problem category with a problem."""
    categories = [c for c in dict.fromkeys(categories) if c in names]
    problems = [c for c in categories if c not in NO_PROBLEM]
    return problems[:3] if problems else categories[:1]


def append_labels(rows, texts, source):
    LABELS.mkdir(parents=True, exist_ok=True)
    stamp = now()
    with open(LABELS_FILE, "a") as f:
        for key, categories in rows:
            f.write(json.dumps({"key": key, "text": texts.get(key, ["", 0])[0], "categories": categories,
                                "source": source, "labeled_at": stamp}) + "\n")


def instructions(categories):
    lines = "\n".join(f"- **{name}**: {meaning}" for name, meaning in categories)
    return f"""# Labeling instructions

You sort warranty notes from a fitness equipment maker (treadmills, ellipticals, exercise
bikes) into problem categories.

Each note is the free-text Issue field of a warranty parts order, written by a support agent.
Notes are lower case, short and full of abbreviations: oob = out of box, mcb = motor
controller board, ra = return authorization, zd = ticket number, w/o = without,
cust = customer, inc = incline, lse = LS error.

## Categories

{lines}

## Rules

- Give each note 1 to 3 categories that describe what is wrong with the machine.
- Give more than one only when the note describes separate problems, for example a noise
  and a worn belt.
- Prefer the most specific category. "e3 incline error" is Incline not working, not
  Error code only.
- Out-of-box is tracked elsewhere. For damage at delivery, pick the category of the damaged part.
- When a note says what was ordered and also what is wrong, label what is wrong.
- Parts order only, Tech visit requested and No issue text are for notes that state no
  problem at all. Never combine them with another category.
- Wrong part sent, Parts not received and Unit replaced or credited may be combined with a
  problem category.
- Copy category names exactly, including capitals and punctuation.

## Input and output

The input file has one JSON object per line: {{"key": "...", "text": "..."}}.
Write the output file with one JSON object per input line, same key, in any order:
{{"key": "...", "categories": ["...", "..."]}}
"""


def cmd_next(args):
    texts = unique_texts(read_orders())
    skip = set(hand_labels()) | pending_keys()

    empty = [k for k in texts if not texts[k][0] and k not in skip]
    if empty:
        append_labels([(k, ["No issue text"]) for k in empty], texts, "rule")
        skip.update(empty)

    candidates = [k for k in texts if k not in skip]
    rnd = random.Random(len(skip))
    predicted = {r["key"]: r["confidence"] for r in read_jsonl(PREDICTED_FILE)}
    if args.uncertain and predicted:
        candidates.sort(key=lambda k: predicted.get(k, 0.0))
        chosen = candidates[:args.size]
    else:
        chosen = spread_over_clusters(candidates, args.size, rnd)

    WORK.mkdir(parents=True, exist_ok=True)
    PENDING.mkdir(parents=True, exist_ok=True)
    (WORK / "INSTRUCTIONS.md").write_text(instructions(read_categories()))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    parts = max(1, args.parts)
    for p in range(parts):
        keys = chosen[p::parts]
        if not keys:
            continue
        name = f"w{stamp}-{p + 1}"
        with open(WORK / f"{name}.jsonl", "w") as f:
            for k in keys:
                f.write(json.dumps({"key": k, "text": " ".join(texts[k][0].split())}) + "\n")
        (PENDING / f"{name}.json").write_text(json.dumps({"name": name, "created_at": now(), "keys": keys}))
        print(f"{WORK / name}.jsonl  ({len(keys)} texts) -> answers go in {name}.out.jsonl")


def spread_over_clusters(candidates, size, rnd):
    """Take about the same number of texts from each cluster, so rare problems get examples too."""
    cluster_file = DATA / "clusters.csv"
    if not cluster_file.exists():
        rnd.shuffle(candidates)
        return candidates[:size]
    cluster_of_order = {r["Id"]: r["Cluster"] for r in csv.DictReader(open(cluster_file, newline=""))}
    cluster_of_key = {}
    for o in read_orders():
        cluster_of_key.setdefault(key_of(clean(o["Issue"])), cluster_of_order.get(o["Id"], "?"))
    groups = defaultdict(list)
    for k in candidates:
        groups[cluster_of_key.get(k, "?")].append(k)
    for keys in groups.values():
        rnd.shuffle(keys)
    chosen, i = [], 0
    while len(chosen) < size and any(i < len(g) for g in groups.values()):
        chosen += [g[i] for g in groups.values() if i < len(g)]
        i += 1
    rnd.shuffle(chosen)
    return chosen[:size]


def cmd_collect(args):
    texts = unique_texts(read_orders())
    names = {n for n, _ in read_categories()}
    for path in sorted(PENDING.glob("*.json")):
        manifest = json.loads(path.read_text())
        name = manifest["name"]
        answers = WORK / f"{name}.out.jsonl"
        if not answers.exists():
            print(f"{name}: no answers yet")
            continue
        wanted = set(manifest["keys"])
        rows, bad = {}, 0
        for line in answers.read_text().splitlines():
            try:
                item = json.loads(line)
                categories = tidy(item["categories"], names)
            except (json.JSONDecodeError, KeyError, TypeError):
                bad += 1
                continue
            if item["key"] in wanted and categories:
                rows[item["key"]] = categories
            else:
                bad += 1
        append_labels(rows.items(), texts, name)
        DONE.mkdir(parents=True, exist_ok=True)
        (DONE / f"{name}.json").write_text(json.dumps({**manifest, "labeled": len(rows), "bad_lines": bad}))
        path.unlink()
        print(f"{name}: saved {len(rows)} of {len(wanted)} labels, {bad} bad lines"
              + ("; missing texts go back in the queue" if len(rows) < len(wanted) else ""))


def cmd_release(args):
    path = PENDING / f"{args.name}.json"
    path.unlink()
    print(f"released {args.name}; its texts go back in the queue")


def load_embeddings(texts):
    """Return (keys, matrix) for every text, embedding the ones the cache does not have."""
    import numpy as np

    cached_texts = EMBEDDED_TEXTS.read_text().split("\n\x00\n") if EMBEDDED_TEXTS.exists() else []
    cached = np.load(EMBEDDINGS) if EMBEDDINGS.exists() else np.zeros((0, 384), dtype=np.float32)
    row_of = {key_of(t): i for i, t in enumerate(cached_texts)}
    missing = [k for k in texts if k not in row_of]
    if missing:
        from sentence_transformers import SentenceTransformer

        print(f"embedding {len(missing)} new texts")
        model = SentenceTransformer(EMBEDDING_MODEL, device="cuda")
        model.max_seq_length = 128
        new = model.encode([texts[k][0] for k in missing], batch_size=512, normalize_embeddings=True)
        cached = np.vstack([cached, new])
        cached_texts += [texts[k][0] for k in missing]
        for i, k in enumerate(missing, len(row_of)):
            row_of[k] = i
        np.save(EMBEDDINGS, cached)
        EMBEDDED_TEXTS.write_text("\n\x00\n".join(cached_texts))
    keys = list(texts)
    return keys, cached[[row_of[k] for k in keys]]


def cmd_predict(args):
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import KFold
    from sklearn.multiclass import OneVsRestClassifier
    from sklearn.preprocessing import MultiLabelBinarizer

    texts = unique_texts(read_orders())
    labels = {k: v for k, v in hand_labels().items() if k in texts}
    if len(labels) < 200:
        print(f"only {len(labels)} hand labels; label more first")
        return
    names = [n for n, _ in read_categories()]
    keys, emb = load_embeddings(texts)
    row = {k: i for i, k in enumerate(keys)}
    train_keys = list(labels)
    X = emb[[row[k] for k in train_keys]]
    mlb = MultiLabelBinarizer(classes=names)
    Y = mlb.fit_transform([labels[k] for k in train_keys])

    def fit(X, Y):
        present = Y.sum(axis=0) > 0
        clf = OneVsRestClassifier(LogisticRegression(C=16.0, max_iter=3000))
        clf.fit(X, Y[:, present])
        return clf, np.array(names)[present]

    def decide(probs, classes):
        order = np.argsort(-probs)
        picked = [classes[i] for i in order[:3] if probs[i] >= 0.5] or [classes[order[0]]]
        return tidy(picked, set(names)), float(probs[order[0]])

    top1_hits, total = 0, 0
    for tr, te in KFold(5, shuffle=True, random_state=0).split(X):
        clf, classes = fit(X[tr], Y[tr])
        for i, probs in zip(te, clf.predict_proba(X[te])):
            categories, _ = decide(probs, classes)
            top1_hits += categories[0] in labels[train_keys[i]]
            total += 1
    print(f"check on hand labels (5-fold): first predicted category is right {100 * top1_hits / total:.1f}% of the time")

    clf, classes = fit(X, Y)
    todo = [k for k in keys if k not in labels]
    with open(PREDICTED_FILE, "w") as f:
        for start in range(0, len(todo), 50_000):
            part = todo[start:start + 50_000]
            for k, probs in zip(part, clf.predict_proba(emb[[row[k] for k in part]])):
                categories, confidence = decide(probs, classes)
                f.write(json.dumps({"key": k, "categories": categories, "confidence": round(confidence, 3)}) + "\n")
    print(f"wrote {PREDICTED_FILE}: {len(todo)} texts, trained on {len(labels)} hand labels")


def cmd_status(args):
    texts = unique_texts(read_orders())
    hand = set(hand_labels()) & texts.keys()
    predicted = {r["key"]: r["confidence"] for r in read_jsonl(PREDICTED_FILE)}
    pending = pending_keys()
    orders = sum(n for _, n in texts.values())

    def line(label, keys):
        n = sum(texts[k][1] for k in keys if k in texts)
        print(f"{label:<22}{len(keys):>8} texts  {n:>8} orders  ({100 * n / orders:.1f}%)")

    print(f"{'all':<22}{len(texts):>8} texts  {orders:>8} orders")
    line("hand labeled", hand)
    line("predicted", {k for k in predicted if k in texts and k not in hand})
    line("  confidence < 0.7", {k for k, c in predicted.items() if c < 0.7 and k in texts and k not in hand})
    line("in open work files", pending)
    line("no label at all", texts.keys() - hand - predicted.keys() - pending)


def cmd_export(args):
    import duckdb

    orders = read_orders()
    LABELS.mkdir(parents=True, exist_ok=True)
    with open(ORDER_INDEX, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Id", "Key", "OutOfBox"])
        for o in orders:
            w.writerow([o["Id"], key_of(clean(o["Issue"])), is_out_of_box(o["Issue"])])
    if not LABELS_FILE.exists() and not PREDICTED_FILE.exists():
        print("no labels yet")
        return
    LABELS_FILE.touch()
    PREDICTED_FILE.touch()
    out = DATA / "order_labels.parquet"
    duckdb.sql(f"""
        COPY (
            WITH h AS (
                SELECT key, arg_max(categories, labeled_at) AS categories
                FROM read_json('{LABELS_FILE}', format = 'newline_delimited',
                               columns = {{key: 'VARCHAR', categories: 'VARCHAR[]', labeled_at: 'VARCHAR'}})
                GROUP BY key
            ),
            p AS (
                SELECT * FROM read_json('{PREDICTED_FILE}', format = 'newline_delimited',
                                        columns = {{key: 'VARCHAR', categories: 'VARCHAR[]', confidence: 'DOUBLE'}})
            )
            SELECT o.Id::INTEGER AS Id, o.OrderDate::TIMESTAMP AS OrderDate,
                   coalesce(h.categories, p.categories) AS Categories,
                   CASE WHEN h.key IS NOT NULL THEN 'hand' WHEN p.key IS NOT NULL THEN 'predicted' END AS LabelSource,
                   CASE WHEN h.key IS NOT NULL THEN 1.0 ELSE p.confidence END AS Confidence,
                   coalesce(string_split(e.ErrorCodes, ';'), []) AS ErrorCodes,
                   i.OutOfBox::BOOLEAN AS OutOfBox, o.OldTags, o.Issue, o.Solution
            FROM read_csv('{DATA / "orders.csv"}', all_varchar = true) o
            JOIN read_csv('{ORDER_INDEX}', all_varchar = true) i ON i.Id = o.Id
            LEFT JOIN h ON h.key = i.Key
            LEFT JOIN p ON p.key = i.Key
            LEFT JOIN read_csv('{DATA / "error_codes.csv"}', all_varchar = true) e ON e.Id = o.Id
            ORDER BY 1
        ) TO '{out}' (FORMAT parquet)
    """)
    print(f"wrote {out}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "collect", "predict", "export"):
        sub.add_parser(name)
    p = sub.add_parser("next")
    p.add_argument("--size", type=int, required=True)
    p.add_argument("--parts", type=int, default=1, help="split into this many work files, one per agent")
    p.add_argument("--uncertain", action="store_true", help="pick texts the classifier is least sure about")
    p = sub.add_parser("release")
    p.add_argument("name")
    args = parser.parse_args()
    {"status": cmd_status, "next": cmd_next, "collect": cmd_collect, "release": cmd_release,
     "predict": cmd_predict, "export": cmd_export}[args.command](args)


if __name__ == "__main__":
    main()
