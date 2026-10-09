"""Download every order that has Issue text from Spirit Web DB, through the Metabase API.

Writes data/orders.csv. Reads METABASE_URL and METABASE_API_KEY from .env.
"""

import json
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
SPIRIT_WEB_DB = 2

QUERY = """
SELECT o.Id, o.OrderDate, o.Issue, o.Solution,
       (SELECT STRING_AGG(e.ModelType + ': ' + e.Description, '; ')
          FROM OrderErrorCodes x JOIN ErrorCodes e ON e.Id = x.ErrorCodeId
         WHERE x.OrderId = o.Id) AS OldTags
  FROM Orders o
 WHERE LEN(LTRIM(ISNULL(o.Issue, ''))) > 0
 ORDER BY o.Id
"""


def load_env():
    env = {}
    for line in (HERE / ".env").read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def main():
    env = load_env()
    body = {
        "query": {"database": SPIRIT_WEB_DB, "type": "native", "native": {"query": QUERY}},
        "format_rows": False,
    }
    req = urllib.request.Request(
        env["METABASE_URL"].rstrip("/") + "/api/dataset/csv",
        data=json.dumps(body).encode(),
        headers={"x-api-key": env["METABASE_API_KEY"], "Content-Type": "application/json"},
    )
    out = HERE / "data" / "orders.csv"
    out.parent.mkdir(exist_ok=True)
    with urllib.request.urlopen(req, timeout=900) as resp, open(out, "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
