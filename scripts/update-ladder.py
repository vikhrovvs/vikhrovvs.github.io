"""Import an export, rebuild all derived data, validate, then optionally upload Secrets."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', nargs='?', help='Full or incremental browser export')
    parser.add_argument('--upload', action='store_true', help='Upload validated source and update manifest; does not commit/push')
    args = parser.parse_args()
    if args.export:
        run('node', 'scripts/import-ladder.mjs', str(Path(args.export).resolve()))
    run('node', 'scripts/build-ladder-graph.mjs')
    run(sys.executable, 'scripts/optimize-gentle-layout.py', '--if-needed')
    run(sys.executable, 'scripts/check_site.py')
    for test in ['archive', 'history', 'paths', 'layout']:
        run('node', f'scripts/test-ladder-{test}.mjs')
    run('node', 'scripts/test-gentle-layout.mjs')
    if args.upload:
        run(sys.executable, 'scripts/ladder-source.py', 'upload')
        run(sys.executable, 'scripts/ladder-source.py', 'check')
    print('Ladder update validated. Review and commit the changed manifest, coordinates and code before pushing.')


if __name__ == '__main__':
    main()
