#!/usr/bin/env python3
"""
Download mistralai/Magistral-Small-2509 from HuggingFace Hub.
"""
import sys
from pathlib import Path
from huggingface_hub import snapshot_download

def main():
    model_id = "mistralai/Magistral-Small-2509"
    local_dir = Path("/run/media/kyle/9ABA27BBBA2792B5/cardmint-models/Magistral-Small-2509")

    print(f"Downloading {model_id} to {local_dir}...")
    print("This may take several minutes depending on network speed.")

    try:
        snapshot_download(
            repo_id=model_id,
            local_dir=str(local_dir),
            local_dir_use_symlinks=False,
            resume_download=True
        )
        print(f"\n✓ Download complete: {local_dir}")
        return 0
    except Exception as e:
        print(f"\n✗ Download failed: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
