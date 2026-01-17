# Rollout Visualizer Data Format

This document describes the JSONL format expected by the Rollout Visualizer and how to configure S3 access for remote file browsing.

## JSONL File Format

Each line in the JSONL file must be a valid JSON object representing a single rollout sample.

### Schema

```json
{
  "messages": [
    {
      "role": "system" | "user" | "assistant" | "tool",
      "content": "string"
    }
  ],
  "attributes": {
    "sample_index": number,
    "step": number,
    "rollout_n": number,
    "reward": number,
    "data_source": "string",
    "experiment_name": "string",
    "validate": boolean
  },
  "timestamp": "ISO 8601 string"
}
```

### Field Descriptions

#### `messages` (required)
An array of message objects representing the conversation/rollout trace.

| Field | Type | Description |
|-------|------|-------------|
| `role` | string | One of: `"system"`, `"user"`, `"assistant"`, `"tool"` |
| `content` | string | The message content. For assistant messages, may contain `<think>...</think>` blocks which are displayed as collapsible "reasoning" sections |

#### `attributes` (required)
Metadata about the sample.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sample_index` | number | 0 | Index within a batch/group of samples |
| `step` | number | 0 | Training step or iteration number |
| `rollout_n` | number | 0 | **Unique identifier** for this rollout. Used for URL linking and deduplication |
| `reward` | number | 0.0 | Reward value for this rollout |
| `data_source` | string | "unknown" | Category/source of the data (e.g., `"coding/test_cases"`, `"maze/reward_evaluation"`) |
| `experiment_name` | string | "unknown" | Name of the experiment run |
| `validate` | boolean | false | Whether this is a validation sample |

#### `timestamp` (required)
ISO 8601 formatted timestamp string (e.g., `"2026-01-16T11:33:10.744140"`).

### Example

```jsonl
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "Hello!"}, {"role": "assistant", "content": "<think>\nLet me think about this...\n</think>\n\nHi there! How can I help you today?"}], "attributes": {"sample_index": 0, "step": 1, "rollout_n": 42, "reward": 1.5, "data_source": "conversation/greeting", "experiment_name": "my_experiment", "validate": false}, "timestamp": "2026-01-16T11:33:10.744140"}
{"messages": [{"role": "system", "content": "You are a coding assistant."}, {"role": "user", "content": "Write hello world"}, {"role": "assistant", "content": "print('Hello, World!')"}], "attributes": {"sample_index": 1, "step": 1, "rollout_n": 43, "reward": 2.0, "data_source": "coding/basic", "experiment_name": "my_experiment", "validate": false}, "timestamp": "2026-01-16T11:33:11.000000"}
```

### Reasoning/Thinking Blocks

The visualizer automatically detects and renders `<think>...</think>` blocks in assistant messages as collapsible "reasoning" sections with special styling. This is useful for chain-of-thought or scratchpad content.

```json
{
  "role": "assistant",
  "content": "<think>\nStep 1: Analyze the problem\nStep 2: Consider edge cases\n</think>\n\nHere is my final answer..."
}
```

---

## Python Logging Helper

Here's a Python class to help log rollout traces in the correct format:

```python
import json
from datetime import datetime
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, asdict
import os

@dataclass
class Message:
    role: str  # "system", "user", "assistant", or "tool"
    content: str

@dataclass
class SampleAttributes:
    sample_index: int
    step: int
    rollout_n: int
    reward: float
    data_source: str
    experiment_name: str
    validate: bool = False

@dataclass
class RolloutSample:
    messages: List[Message]
    attributes: SampleAttributes
    timestamp: str = None
    
    def __post_init__(self):
        if self.timestamp is None:
            self.timestamp = datetime.now().isoformat()
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "messages": [asdict(m) for m in self.messages],
            "attributes": asdict(self.attributes),
            "timestamp": self.timestamp
        }
    
    def to_json(self) -> str:
        return json.dumps(self.to_dict())


class RolloutLogger:
    """Logger for rollout traces in JSONL format."""
    
    def __init__(self, file_path: str):
        self.file_path = file_path
        # Ensure directory exists
        os.makedirs(os.path.dirname(file_path) or ".", exist_ok=True)
    
    def log(self, sample: RolloutSample):
        """Append a single sample to the JSONL file."""
        with open(self.file_path, 'a') as f:
            f.write(sample.to_json() + '\n')
    
    def log_rollout(
        self,
        messages: List[Dict[str, str]],
        rollout_n: int,
        reward: float,
        step: int = 1,
        sample_index: int = 0,
        data_source: str = "unknown",
        experiment_name: str = "experiment",
        validate: bool = False
    ):
        """Convenience method to log a rollout with minimal boilerplate."""
        sample = RolloutSample(
            messages=[Message(**m) for m in messages],
            attributes=SampleAttributes(
                sample_index=sample_index,
                step=step,
                rollout_n=rollout_n,
                reward=reward,
                data_source=data_source,
                experiment_name=experiment_name,
                validate=validate
            )
        )
        self.log(sample)


# Usage example
if __name__ == "__main__":
    logger = RolloutLogger("rollouts/my_experiment.jsonl")
    
    # Log a rollout
    logger.log_rollout(
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "<think>\nSimple arithmetic: 2+2=4\n</think>\n\nThe answer is 4."}
        ],
        rollout_n=1,
        reward=1.0,
        step=100,
        data_source="math/arithmetic",
        experiment_name="math_training_v1"
    )
```

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
