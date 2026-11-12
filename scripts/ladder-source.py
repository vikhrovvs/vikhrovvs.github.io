"""Store the local ladder source in Actions Secrets, or restore it during deployment."""
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
ARCHIVE = ROOT / "data/ladder-graph/archive.json"
MANIFEST = ROOT / "data/ladder-source.json"
SECRET_NAMES = [f"LADDER_SOURCE_{i}" for i in range(1, 4)]


def canonical_source(raw: bytes) -> bytes:
    source = json.loads(raw)
    assert source["games"] and not source["failures"], "Incomplete archive"
    return json.dumps(source, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def prepare() -> tuple[bytes, list[str], dict]:
    raw = canonical_source(ARCHIVE.read_bytes())
    encoded = base64.b64encode(gzip.compress(raw, mtime=0)).decode("ascii")
    size = (len(encoded) + len(SECRET_NAMES) - 1) // len(SECRET_NAMES)
    if size > 45000:
        raise ValueError("Archive exceeds configured secret capacity; add more parts before uploading")
    parts = [encoded[i * size:(i + 1) * size] for i in range(len(SECRET_NAMES))]
    manifest = {"schemaVersion": 1, "encoding": "gzip+base64", "sha256": hashlib.sha256(raw).hexdigest(), "parts": len(parts)}
    return raw, parts, manifest


def restore(parts: list[str], manifest: dict) -> bytes:
    if manifest["schemaVersion"] != 1 or manifest["encoding"] != "gzip+base64" or manifest["parts"] != len(SECRET_NAMES):
        raise ValueError("Unsupported source manifest")
    if not all(parts):
        raise ValueError("Missing LADDER_SOURCE Actions Secrets")
    raw = gzip.decompress(base64.b64decode("".join(parts), validate=True))
    if hashlib.sha256(raw).hexdigest() != manifest["sha256"]:
        raise ValueError("Private source checksum mismatch; update all secret parts and the manifest together")
    canonical_source(raw)
    return raw


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["upload", "restore", "check"])
    parser.add_argument("--repo", default="vikhrovvs/vikhrovvs.github.io")
    args = parser.parse_args()
    if args.command == "restore":
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        raw = restore([os.environ.get(name, "") for name in SECRET_NAMES], manifest)
        ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
        ARCHIVE.write_bytes(raw)
        print("Private source restored and checksum verified")
        return
    raw, parts, manifest = prepare()
    assert restore(parts, manifest) == raw
    if args.command == "check":
        assert json.loads(MANIFEST.read_text(encoding="utf-8")) == manifest
        print("Source round-trip and manifest verified; missing/corrupt parts must fail")
        for broken in [["", *parts[1:]], ["!!!!", *parts[1:]]]:
            try:
                restore(broken, manifest)
            except (ValueError, OSError):
                continue
            raise AssertionError("Corrupt source was accepted")
        return
    subprocess.run(["gh", "auth", "status"], check=True, capture_output=True)
    for name, part in zip(SECRET_NAMES, parts):
        subprocess.run(["gh", "secret", "set", name, "--repo", args.repo], input=part.encode("ascii"), check=True)
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Private source uploaded; commit data/ladder-source.json with the deployment changes")


if __name__ == "__main__":
    main()
