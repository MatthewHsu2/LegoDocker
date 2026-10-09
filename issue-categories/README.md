# issue-categories

Sort the free-text `Issue` notes in Spirit Web DB (`dbo.Orders`) into problem categories,
and pull machine error codes (E5, E50H, LS1, ...) out of `Issue` and `Solution`.

This is analysis work, not a service. Nothing here writes to the database.

## Setup

```bash
cp .env.example .env     # then fill in the Metabase URL and API key
uv sync
```

## Steps

| Step | Command | Output |
|---|---|---|
| 1. Download the orders | `uv run python pull.py` | `data/orders.csv` |
| 2. Find error codes | `uv run python error_codes.py` | `data/error_codes.csv` |
| 3. Group similar issues | `uv run python cluster.py 80` | `data/clusters.csv`, `data/clusters.md` |
| 4. Name the groups | edit `cluster_map.csv` by hand | |
| 5. Label every order (draft) | `uv run python categorize.py` | `data/issue_categories.csv` |
| 6. Better labels | `uv run python label.py ...` (see below) | `data/order_labels.parquet` |
| 7. Excel report | `uv run python report.py 2026` | `data/reports/top-problems-2026.xlsx` |

`data/` holds customer text. Git ignores it.

## How the error-code rules work

- `E5`, `e-5`, `E 5`, `E05`, `E5oob`, `ERROR 5`, `ERR-6` all become `E5` / `E6`.
- An `H` suffix is kept: `E50H`, `E10-H` become `E50H`, `E10H`.
- `E15 E20 E25 E35 E55 E75 E95 E98` are Sole elliptical models. They count as a code only
  when "error" or "code" follows close after, or with an `H` suffix.
- `LS`, `LS1`, `LS-1`, `LSI`, and "low speed error" become `LS` or `LS1`.
- `LS ERROR 30 MINUTES INTO...` is `LS`, not `E30`.

The rules come from real notes. `test_error_codes.py` holds those notes and the expected codes.
Run it with `uv run pytest`.

## How the grouping works

1. Remove words about who called ("tech called", "per customer", "Other,", "Gen. Help,").
2. Remove exact duplicates.
3. Turn each text into an embedding (a list of numbers; similar texts get close numbers).
   Model: `BAAI/bge-small-en-v1.5`, on the GPU.
4. Split the embeddings into k groups with k-means.
5. `data/clusters.md` shows each group: size, old tags, error codes, and sample texts.
   A person (or an AI) reads it and gives each group a name in `cluster_map.csv`.
   Many groups get the same name. 80 groups became 45 categories.

## Out-of-box flag

`OutOfBox` in `data/issue_categories.csv` is `yes` when the Issue note says `oob`,
`o.o.b.` or "out of (the) box". It is a separate column, not a category, because
out-of-box problems show up in almost every category. "DOA" does not count: in these
notes it is about a replacement part, not the machine.

## Limits of the draft labels

- One label per order. A note that says "noise and worn belt" gets only one of them.
- About 1 order in 4 gets the wrong label. Example: "emailed order for brake - resistance
  too high" lands in "No problem stated", because the group is mostly order notes.
- "No problem stated" (about 10%) is real: those notes only say what was ordered.
  The `Solution` field may still say which part was sent.
- `cluster_map.csv` fits one run of `cluster.py 80` only. A new run needs a new map.

## Labeling (label.py)

The draft labels come from whole clusters. `label.py` gives each note its own labels.

- **Hand labels**: a Claude Code agent reads a work file and picks 1-3 categories per note
  from `categories.csv`. Saved in `data/labels/labels.jsonl`.
- **Predicted labels**: a classifier trained on the hand labels and the embeddings labels
  every other note, with a confidence from 0 to 1. Saved in `data/labels/predicted.jsonl`.
  Hand labels always win.

Each unique cleaned note gets one label, and every order with that note shares it.

### One round

```bash
uv run python label.py status                     # what is labeled, what is left
uv run python label.py next --size 3000 --parts 10   # 10 work files of 300 notes
# ask Claude Code: "label the open work files in data/labels/work"
uv run python label.py collect                    # save the answers
uv run python label.py predict                    # retrain, relabel the rest
uv run python label.py export                     # write data/order_labels.parquet
```

Later rounds: `next --uncertain` picks the notes the classifier is least sure about.

### Stop and continue

Nothing is lost when a round stops half way. A note gets a new work file only when it has
no hand label and is not in an open work file. `collect` saves whatever answers exist; notes
without an answer go back in the queue. `release NAME` gives up an open work file.

### New orders

```bash
uv run python pull.py && uv run python error_codes.py
uv run python label.py predict && uv run python label.py export
```

`predict` embeds new notes and labels them. Run a `next` round to hand-label some of them too.

### Query with DuckDB

```sql
-- categories by year
SELECT yr, category, count(*) AS orders
FROM (SELECT year(OrderDate) AS yr, unnest(Categories) AS category FROM 'data/order_labels.parquet')
GROUP BY ALL ORDER BY yr, orders DESC;

-- orders with E5, out of box
SELECT Id, OrderDate, Categories, Issue
FROM 'data/order_labels.parquet'
WHERE list_contains(ErrorCodes, 'E5') AND OutOfBox;

-- confident labels (about 94% right)
SELECT * FROM 'data/order_labels.parquet' WHERE Confidence >= 0.7;
```

Columns: `Id`, `OrderDate`, `Categories` (list), `LabelSource` (`hand` / `predicted`),
`Confidence`, `ErrorCodes` (list), `OutOfBox`, `OldTags`, `Issue`, `Solution`.

## Excel report (report.py)

`report.py <year>` writes one tab with the months side by side, January on the left. Each
month lists every model
(first 6 characters of the serial number) with its top 5 problem categories: orders with the
category, % of the model's orders that month, and item cost (Quantity × Products.Cost). Only
orders that are `Approved` and have a `Shipped` shipping order count.

Run `label.py export` first so the labels are current. The cells hold plain values, not formulas.
