#!/usr/bin/env python3
"""Offline retrieval for public decision methods (stdlib only)."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import re
import unicodedata


PUBLIC_FIELDS = ("id", "person", "person_name", "kind", "title", "summary", "conditions", "boundaries", "questions", "actions", "status")
def public_record(row):
    if row.get("kind") not in ("principle", "method") or row.get("status") != "method_synthesis":
        raise ValueError("This public runtime accepts reviewed method_synthesis cards only; source/case records are not distributed.")
    clean = {key: row[key] for key in PUBLIC_FIELDS if key in row}
    for key, value in clean.items():
        if key in ("conditions", "boundaries", "questions", "actions"):
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                raise ValueError("Invalid public method list field")
        elif not isinstance(value, str):
            raise ValueError("Invalid public method text field")
    clean["search_fields"] = {key: value for key, value in clean.items()}
    return clean


def normalize(text):
    return unicodedata.normalize("NFKC", str(text)).lower()


def tokens(text):
    text = normalize(text)
    result = re.findall(r"[a-z0-9]+(?:[-_][a-z0-9]+)*", text)
    for run in re.findall(r"[\u3400-\u9fff]+", text):
        result.extend(run[i:i + 2] for i in range(len(run) - 1))
        if len(run) == 1:
            result.append(run)
    return result


def flatten(value):
    if isinstance(value, dict):
        return " ".join(flatten(v) for v in value.values())
    if isinstance(value, list):
        return " ".join(flatten(v) for v in value)
    return "" if value is None else str(value)


def search(records, query, person=None, kind=None, limit=8):
    candidates = [public_record(r) for r in records
                  if (not person or person in (r.get("person"), r.get("person_name")))
                  and (not kind or (r.get("kind") == kind or kind == "method"))]
    if not candidates:
        return []
    q = Counter(tokens(query))
    if not q:
        return []
    docs = [Counter(tokens(flatten(r.get("search_fields", {})))) for r in candidates]
    lengths = [sum(d.values()) for d in docs]
    avg = sum(lengths) / max(len(lengths), 1) or 1
    df = Counter(term for d in docs for term in d)
    hits = []
    for record, d, length in zip(candidates, docs, lengths):
        score = 0.0
        matched = []
        for term in q:
            freq = d.get(term, 0)
            if not freq:
                continue
            matched.append(term)
            idf = math.log(1 + (len(docs) - df[term] + .5) / (df[term] + .5))
            score += idf * freq * 2.2 / (freq + 1.2 * (.25 + .75 * length / avg))
        if not matched:
            continue
        title = normalize(record.get("title", ""))
        if normalize(query).strip() in title:
            score += 3
        if normalize(query).strip() == normalize(record.get("id", "")):
            score += 10
        hit = {k: v for k, v in record.items() if k != "search_fields"}
        hit.update(score=round(score, 4), matched_terms=matched)
        hits.append(hit)
    return sorted(hits, key=lambda r: (-r["score"], r["id"]))[:limit]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("query")
    parser.add_argument("--person", help="Person slug or indexed name; jobs is an alias for steve-jobs")
    parser.add_argument("--kind", choices=["principle", "method"])
    parser.add_argument("--limit", type=int, default=8)
    parser.add_argument("--index", type=Path)
    args = parser.parse_args()
    here = Path(__file__).resolve().parent
    default = here.parent / "references" / "search-index.json"
    if not default.exists():
        default = here.parent / "library" / "search-index.json"
    if args.index and args.index.resolve() != default.resolve():
        parser.error("Public runtime only reads its bundled method index.")
    index = default
    if not 1 <= args.limit <= 50:
        parser.error("--limit must be 1..50")
    if not index.is_file():
        parser.error(f"Index not found: {index}; build the library first")
    records = json.loads(index.read_text(encoding="utf-8"))
    if args.person is not None:
        slugs = sorted({r["person"] for r in records if r.get("person")})
        names = {r["person_name"]: r["person"] for r in records
                 if r.get("person_name") and r.get("person")}
        from chatroom import ALIASES
        person = ALIASES.get(args.person, ALIASES.get(args.person.lower(), args.person))
        person = names.get(person, person)
        if person not in slugs:
            parser.error(f"Unknown --person {args.person!r}. Valid slugs in this index: "
                         + (", ".join(slugs) or "(none)")
                         + ". Alias: jobs -> steve-jobs (when present).")
        args.person = person
    hits = search(records, args.query, args.person, args.kind, args.limit)
    print(json.dumps({"query": args.query, "method": "lexical-bm25-english-and-chinese-bigrams",
                      "warning": "Relevance is not evidence confidence. Method IDs do not establish quotations or source verification. Sources are not included in this distribution.",
                      "count": len(hits), "results": hits}, ensure_ascii=False, indent=2))



if __name__ == "__main__":
    main()
