#!/usr/bin/env python3
"""Optional derived Parquet export. Install pyarrow separately; it is not a game dependency."""
import argparse
import json
from pathlib import Path

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path, help='Directory created by npm run export')
    args = parser.parse_args()
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError:
        parser.exit(2, 'Optional package missing: install pyarrow in your analysis environment.\n')
    if not args.directory.is_dir():
        parser.error('Export directory does not exist.')
    for name in ('moves', 'candidates', 'cells', 'answers', 'requests'):
        source = args.directory / f'{name}.jsonl'
        if not source.exists():
            continue
        rows = [json.loads(line) for line in source.read_text(encoding='utf-8').splitlines() if line.strip()]
        if rows:
            pq.write_table(pa.Table.from_pylist(rows), args.directory / f'{name}.parquet', compression='zstd')
            print(f'{name}: {len(rows)} rows')
        else:
            print(f'{name}: no observations; no schema invented')

if __name__ == '__main__':
    main()
