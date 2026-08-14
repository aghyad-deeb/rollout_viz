#!/usr/bin/env python3
"""One-shot bucket protection for s3://rewardseeker — versioning + lifecycle.

Run with BUCKET-ADMIN credentials (the ~/.env keys on the viz box are
data-plane only and get AccessDenied on bucket configuration):

    AWS_PROFILE=<admin> python3 scripts/apply_bucket_protection.py [--dry-run]

What it does (and why):
1. Enables bucket VERSIONING — protects against the overwrite/append class of
   bugs without changing a single key. Every reader keeps working untouched.
2. Adds lifecycle rules (MERGED with any existing rules, never clobbered):
   - Expire NONCURRENT versions after 30 days. viz/ grade sidecars are
     rewritten whole on every grade merge, so without this, versioning would
     accumulate a copy per merge forever.
   - Transition bulk trace prefixes to STANDARD_IA after 30 days and
     GLACIER_IR after 180 days: logs_jsonl/rollout_traces_tinker/ (~58GB),
     logs_jsonl/rollout_traces/ (legacy verl traces), debug_traces/ (~6.2GB),
     and logs_jsonl/debug_traces/ (the canonical spot for new ones).
     Both storage classes keep get_object INSTANT — the viewer, fetch API,
     and every consumer keep working with no restore step. Deep Archive /
     Flexible Retrieval are deliberately NOT used (they would break reads).

Nothing here moves, renames, or rewrites any object. Canonical identity
(file path + line index) is untouched.
"""

import argparse
import json
import sys

import boto3
from botocore.exceptions import ClientError

BUCKET = "rewardseeker"

ARCHIVE_PREFIXES = [
    "logs_jsonl/rollout_traces_tinker/",
    "logs_jsonl/rollout_traces/",
    "debug_traces/",
    "logs_jsonl/debug_traces/",
]

RULE_ID_PREFIX = "viz-protection"


def desired_rules():
    rules = [
        {
            "ID": f"{RULE_ID_PREFIX}-noncurrent-expiry",
            "Filter": {},  # whole bucket
            "Status": "Enabled",
            "NoncurrentVersionExpiration": {"NoncurrentDays": 30},
            "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7},
        }
    ]
    for prefix in ARCHIVE_PREFIXES:
        slug = prefix.strip("/").replace("/", "-")
        rules.append({
            "ID": f"{RULE_ID_PREFIX}-archive-{slug}",
            "Filter": {"Prefix": prefix},
            "Status": "Enabled",
            "Transitions": [
                {"Days": 30, "StorageClass": "STANDARD_IA"},
                {"Days": 180, "StorageClass": "GLACIER_IR"},
            ],
        })
    return rules


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="print, change nothing")
    args = parser.parse_args()

    s3 = boto3.client("s3")

    # --- Versioning ---
    status = s3.get_bucket_versioning(Bucket=BUCKET).get("Status", "Disabled")
    print(f"versioning: {status}")
    if status != "Enabled":
        if args.dry_run:
            print("would enable versioning")
        else:
            s3.put_bucket_versioning(
                Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"}
            )
            print("versioning enabled")

    # --- Lifecycle: merge with existing rules, replace only our own IDs ---
    try:
        existing = s3.get_bucket_lifecycle_configuration(Bucket=BUCKET)["Rules"]
    except ClientError as e:
        if e.response["Error"]["Code"] != "NoSuchLifecycleConfiguration":
            raise
        existing = []
    kept = [r for r in existing if not r.get("ID", "").startswith(RULE_ID_PREFIX)]
    merged = kept + desired_rules()

    print(f"lifecycle: {len(existing)} existing rule(s), "
          f"{len(kept)} kept, {len(desired_rules())} viz-protection rule(s) applied")
    if args.dry_run:
        print(json.dumps(merged, indent=2))
        return 0

    s3.put_bucket_lifecycle_configuration(
        Bucket=BUCKET, LifecycleConfiguration={"Rules": merged}
    )
    print("lifecycle configuration applied")
    return 0


if __name__ == "__main__":
    sys.exit(main())
