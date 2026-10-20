#!/usr/bin/env python3
"""Safely fingerprint a downloaded FineFake archive without extracting or unpickling it.

The publisher does not publish a signed archive digest in the repository README.
This utility therefore records a local SHA-256 for a reviewer to pin after
checking the download provenance. It is intentionally metadata-only: it never
extracts archive members and never loads Python pickle data.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import zipfile
from pathlib import Path

OFFICIAL_REPOSITORY = "https://github.com/Accuser907/FineFake"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_archive(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"FineFake archive does not exist: {path}")
    size = path.stat().st_size
    if size <= 0:
        raise ValueError("FineFake archive is empty.")

    report = {
        "schema_version": 1,
        "dataset": "FineFake",
        "official_repository": OFFICIAL_REPOSITORY,
        "archive_name": path.name,
        "archive_size_bytes": size,
        "archive_sha256": sha256_file(path),
        "archive_format": "zip" if zipfile.is_zipfile(path) else "opaque_non_zip",
        "members_listed_without_extraction": [],
        "pickle_members_present": False,
        "publisher_signed_checksum_available": False,
        "verification_status": "LOCAL_SHA256_COMPUTED_PROVENANCE_REQUIRES_REVIEW",
        "safety_note": (
            "No files were extracted and no pickle payload was loaded. A computed "
            "hash identifies these bytes but does not by itself authenticate the source."
        ),
    }
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 20000:
                raise ValueError("Archive has an unexpectedly large member count; refusing to enumerate it.")
            report["members_listed_without_extraction"] = [
                {
                    "name": info.filename,
                    "compressed_bytes": info.compress_size,
                    "uncompressed_bytes": info.file_size,
                    "is_directory": info.is_dir(),
                }
                for info in infos
            ]
            report["pickle_members_present"] = any(
                info.filename.lower().endswith((".pkl", ".pickle")) for info in infos
            )
            report["total_declared_uncompressed_bytes"] = sum(info.file_size for info in infos)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = audit_archive(args.archive)
    output = args.output or args.archive.with_suffix(args.archive.suffix + ".audit.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "members_listed_without_extraction"}, indent=2))
    print(f"Audit report: {output}")


if __name__ == "__main__":
    main()
