# Rollout Visualizer Data Format

This document describes the JSONL format expected by the Rollout Visualizer and how to configure S3 access for remote file browsing.

## JSONL File Format

Each line in the JSONL file is a JSON object representing a single rollout sample.

**Only `messages` is required.** Everything else is optional — **omit fields you don't have rather than faking them.** Producers historically wrote `reward: 0`, `step: 1`, `sample_index: 0` "for compatibility"; the viewer applies defaults itself, hides columns that are constant at their default across a whole file, and fake values actively pollute the Analysis charts.

### Schema

```json
{
  "messages": [
    {
      "role": "system" | "user" | "assistant" | "tool",
      "content": "string",
      "content_parts": [ ... ],   // optional; reasoning/text parts pass through losslessly
      "tool_calls": [ ... ]       // optional; rendered as structured tool-call blocks
    }
  ],
  "attributes": { ... },          // optional; see below
  "grades": { ... },              // optional; written by the grading UI, not producers
  "diagnostics": ["string"],      // optional; producer notes, surfaced as a "diag" pill
  "timestamp": "ISO 8601 string"  // optional; the writer library fills it in
}
```

### Field Descriptions

#### `messages` (required)
An array of message objects representing the conversation/rollout trace.

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | One of: `"system"`, `"user"`, `"assistant"`, `"tool"` |
| `content` | string | The message content. Assistant messages may contain `<think>...</think>` blocks or raw ChatML/Harmony token decodes — both render as collapsible reasoning sections |
| `content_parts` | array | Optional structured parts (`{type: "text"|"reasoning"|"thinking", text}`) — preferred over inline tags when you have them |
| `tool_calls` | array | Optional OpenAI-style tool calls (`{function: {name, arguments}}`) |

#### `attributes` (optional)
Metadata about the sample. **Every field is optional. Omit what you don't have.**

| Field | Type | Meaning when present |
|-------|------|----------------------|
| `viz_id` | string | Stable unique id for this rollout. Stamped automatically by the writer library — the forward-looking identity for links |
| `rollout_n` | number | Unique-within-file rollout number. Legacy `?rollout=` links resolve through it; must be UNIQUE per file or links are ambiguous |
| `sample_index` | number | The problem/group the rollout belongs to (e.g. GRPO group id). NOT a unique id |
| `step` | number | Training step that produced this rollout |
| `reward` | number | Actual reward. **Never write 0 as a placeholder** — omit instead |
| `data_source` | string | Task category (e.g. `"coding/test_cases"`) |
| `experiment_name` | string | Experiment run name |

`validate` (boolean) is deprecated: the backend renames it to `is_validate` for legacy files, but no producer sets it meaningfully — omit it.

#### `timestamp` (optional)
ISO 8601 string. The writer library fills it automatically when absent.

#### `grades` (optional — written by the app, not by producers)
`{metric_name: [GradeEntry, ...]}`. The lists are **append-only**: the grading UI and the human-annotation surfaces only ever append, so a metric's list is its full history (successive judge runs, then human verdicts/audits, oldest first).

The reserved `comments` metric holds per-rollout free-text human notes (`grade_type: "freeform"`, text in `grade`, `model: "human:<name>"`, `prompt_version: "comment-v1"`). Because nothing is ever removed from the log, **deleting a comment appends a tombstone** instead:

```json
{
  "grade": "", "grade_type": "freeform", "quotes": [],
  "explanation": "deleted comment by human:ada from 2026-08-08T07:26:08.671Z",
  "model": "human:grace",
  "prompt_version": "comment-delete-v1",
  "timestamp": "2026-08-09T11:02:44.108Z",
  "deletes": {"model": "human:ada", "timestamp": "2026-08-08T07:26:08.671Z"}
}
```

A machine consumer reading `comments` must filter the list the way the app's `visibleComments()` does (`frontend/src/utils/humanGrades.ts`): drop every entry that is a tombstone (`prompt_version == "comment-delete-v1"` **or** a `deletes` field is present), and every entry whose `(model, timestamp)` pair equals some tombstone's `deletes`. Entries sharing one `(model, timestamp)` pair are indistinguishable, so a single tombstone retracts all of them. A tombstone with no matching target is inert.

### Canonical links

The canonical deep link to one sample is **`?file=<path>&index=<n>`**, where `index` is the sample's line position in the file (0-based). `?rollout=<rollout_n>` remains supported forever for old links, but new producers should emit `index` links — the writer library returns them from every write.

### Reasoning/Thinking Blocks

The visualizer automatically detects and renders `<think>...</think>` blocks, ChatML (`<|im_start|>...`), and raw GPT-OSS Harmony decodes (`<|channel|>analysis<|message|>...`) in assistant messages as collapsible "reasoning" sections and structured tool calls. Logging the raw token decode is fine — the viewer parses it.

---

## Writing Files: the `viz_writer` Library

**Do not hand-roll JSONL + boto3.** The `viz_writer` package (in this repo, installed editable in the shared venv at `/home/ubuntu/reward_seeker/venv`) is the one blessed writer. It validates permissively, passes unknown fields through losslessly, stamps `attributes.viz_id`, never fabricates training fields, writes local or `s3://` destinations, and returns clickable canonical URLs.

```python
from viz_writer import write_rollouts

samples = [
    {
        "messages": [
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "<think>2+2=4</think>\n\nThe answer is 4."},
        ],
        "attributes": {"experiment_name": "math_training_v1", "data_source": "math/arithmetic", "reward": 1.0},
    },
]

result = write_rollouts(samples, "s3://rewardseeker/logs_jsonl/my_experiment/run_1.jsonl")
print(result.url)             # file-level rollout_viz link
print(result.sample_urls[0])  # deep link to the first sample (?file=...&index=0)

# Appending to an existing file:
write_rollouts(more_samples, result.uri, mode="append")
```

Set `VIZ_BASE_URL` when the viewer is tunneled or remote (default `http://localhost:3000`).

### Canonical bucket layout

`viz_writer.dest_for(kind, name)` returns the one blessed destination for a NEW trace
file — producers must not invent prefixes:

| kind | destination |
|---|---|
| `session` | `s3://rewardseeker/logs_jsonl/cli_sessions/<date>/<name>.jsonl` |
| `probe` | `s3://rewardseeker/logs_jsonl/target_probes/<date>/<name>.jsonl` |
| `debug` | `s3://rewardseeker/logs_jsonl/debug_traces/<date>/<name>.jsonl` |
| `chat` / `online_chat` | `s3://rewardseeker/logs_jsonl/chats|online_chats/<date>/<name>.jsonl` |
| `eval` | `s3://rewardseeker/logs_jsonl/auto_eval/<date>/<name>.jsonl` |
| `training_run` | `s3://rewardseeker/logs_jsonl/rollout_traces_tinker/<date>/<name>.jsonl` |

**Historical files are never moved.** The canonical sample identity is
`(file path, line index)` — every share link, results.md, and eval config points at a
path, and viz/ grade sidecars are aligned to their originals positionally. Legacy
prefixes (root-level `cli_sessions/`, `target_probes/`, `debug_traces/`) stay where
their links point; the viewer's Library lists both old and new locations for each kind.

## Reading Rollouts: the Fetch API

Machine consumers should read rollouts through `GET /api/rollout` instead of fetching S3 directly — it resolves the graded `viz/` overlay (raw fetches silently miss grades):

```
GET /api/rollout?url=<encoded rollout_viz link>            → canonical JSON
GET /api/rollout?file=<path>&index=<n>&format=plaintext    → fixed plaintext transcript
Authorization: Bearer <VIZ_API_TOKEN from ~/.env>
```

There is exactly one plaintext format and truncation policy — per-caller formatting options are deliberately not offered.

---

## S3 Configuration

To browse and load files from S3, you need to configure AWS credentials.

### Option 1: Environment File (Recommended)

Create a `~/.env` file with your AWS credentials:

```bash
AWS_ACCESS_KEY_ID=your_access_key_id
AWS_SECRET_ACCESS_KEY=your_secret_access_key
AWS_DEFAULT_REGION=us-east-1
```

The visualizer backend automatically loads credentials from this file.

### Option 2: AWS CLI Configuration

Configure AWS CLI with your credentials:

```bash
aws configure
```

This creates `~/.aws/credentials` and `~/.aws/config` files that boto3 uses automatically.

### Option 3: Environment Variables

Export credentials directly:

```bash
export AWS_ACCESS_KEY_ID=your_access_key_id
export AWS_SECRET_ACCESS_KEY=your_secret_access_key
export AWS_DEFAULT_REGION=us-east-1
```

### Option 4: IAM Roles (EC2/ECS)

If running on AWS infrastructure, use IAM roles attached to your EC2 instance or ECS task.

---

## Uploading to S3

### Using AWS CLI

```bash
# Upload a single file
aws s3 cp rollouts.jsonl s3://your-bucket/logs_jsonl/experiment_name/rollouts.jsonl

# Upload a directory
aws s3 sync ./rollouts/ s3://your-bucket/logs_jsonl/experiment_name/

# Upload with specific prefix structure
aws s3 cp rollouts.jsonl s3://your-bucket/logs_jsonl/$(date +%Y-%m-%d)/experiment_v1.jsonl
```

### Using Python (boto3)

```python
import boto3
from datetime import datetime

def upload_to_s3(local_path: str, bucket: str, key: str):
    """Upload a file to S3."""
    s3_client = boto3.client('s3')
    s3_client.upload_file(local_path, bucket, key)

# Example: Upload with date-based organization
bucket = "your-bucket"
experiment = "my_experiment"
date_str = datetime.now().strftime("%Y-%m-%d")
key = f"logs_jsonl/rollout_traces/{experiment}/{date_str}/rollouts.jsonl"

upload_to_s3("rollouts.jsonl", bucket, key)
print(f"Uploaded to s3://{bucket}/{key}")
```

### S3 Logger (Direct Upload)

For real-time logging directly to S3:

```python
import boto3
import json
from datetime import datetime
from io import StringIO

class S3RolloutLogger:
    """Logger that writes directly to S3."""
    
    def __init__(self, bucket: str, key_prefix: str, experiment_name: str):
        self.s3_client = boto3.client('s3')
        self.bucket = bucket
        self.experiment_name = experiment_name
        
        # Create unique file name with timestamp
        timestamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        self.key = f"{key_prefix}/{experiment_name}/{timestamp}.jsonl"
        
        self.buffer = StringIO()
        self.sample_count = 0
    
    def log(self, sample: dict):
        """Buffer a sample for upload."""
        self.buffer.write(json.dumps(sample) + '\n')
        self.sample_count += 1
        
        # Flush every 100 samples
        if self.sample_count % 100 == 0:
            self.flush()
    
    def flush(self):
        """Upload buffered samples to S3."""
        if self.buffer.tell() == 0:
            return
        
        # Read current S3 content (if exists) and append
        try:
            response = self.s3_client.get_object(Bucket=self.bucket, Key=self.key)
            existing = response['Body'].read().decode('utf-8')
        except self.s3_client.exceptions.NoSuchKey:
            existing = ""
        
        # Upload combined content
        content = existing + self.buffer.getvalue()
        self.s3_client.put_object(
            Bucket=self.bucket,
            Key=self.key,
            Body=content.encode('utf-8'),
            ContentType='application/jsonl'
        )
        
        # Reset buffer
        self.buffer = StringIO()
    
    def close(self):
        """Flush remaining samples and close."""
        self.flush()
        print(f"Logged {self.sample_count} samples to s3://{self.bucket}/{self.key}")
```

---

## Recommended S3 Directory Structure

```
s3://your-bucket/
└── logs_jsonl/
    └── rollout_traces/
        └── experiment_name/
            └── 2026-01-16/
                ├── step_1_worker01.jsonl
                ├── step_1_worker02.jsonl
                ├── step_2_worker01.jsonl
                └── ...
```

This structure allows:
- Easy filtering by experiment name
- Date-based organization for cleanup policies
- Worker-based separation for parallel training
- Using the visualizer's file browser to navigate and select specific files

---

## Loading in the Visualizer

### From Local Path
1. Enter the file path in the header (e.g., `./rollouts/experiment.jsonl`)
2. Or click the folder icon to browse local directories

### From S3
1. Click the folder icon to open the file browser
2. Enter an S3 path: `s3://bucket-name/logs_jsonl/experiment/`
3. Click "Open" to navigate folders or "Browse All" to list all JSONL files recursively
4. Select files (checkbox) and click "Load Selected"

### Multiple Files
You can select and load multiple JSONL files simultaneously. Samples will be combined and each sample will have a `source_file` attribute added for tracking.
