# SmolVLM Fine-Tuning Instructions for MacBook Pro M4

## Overview
This document provides complete instructions for fine-tuning SmolVLM-500M on a MacBook Pro M4 with 24GB unified memory for the CardMint Pokemon card recognition system. The trained model will be exported and deployed on a Fedora 42 system.

## System Requirements

### MacBook Pro M4 Specifications
- **Processor**: Apple M4 chip
- **Memory**: 24GB unified memory (minimum 16GB free)
- **Storage**: 50GB free space
- **OS**: macOS 14.0 or later
- **Python**: 3.10 or 3.11 (3.12 may have compatibility issues)

### Software Prerequisites
```bash
# Check Python version
python3 --version  # Should be 3.10.x or 3.11.x

# Install Homebrew if not present
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install required system packages
brew install wget cmake
```

## Phase 1: Environment Setup (10 minutes)

### 1.1 Create Project Directory
```bash
cd ~
mkdir cardmint_training
cd cardmint_training
```

### 1.2 Download Training Package
```bash
# Option A: If you have the tar.gz file
tar -xzf smolvlm_m4_training.tar.gz
cd smolvlm_training

# Option B: Clone from repository
git clone https://github.com/your-repo/cardmint-training.git
cd cardmint-training
```

### 1.3 Create Virtual Environment
```bash
# Create venv with Python 3.11 specifically
python3.11 -m venv venv

# Activate environment
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip
```

### 1.4 Install PyTorch for Apple Silicon
```bash
# Install PyTorch with MPS (Metal Performance Shaders) support
pip install torch==2.1.0 torchvision==0.16.0 torchaudio==2.1.0

# Verify MPS availability
python -c "import torch; print(f'MPS available: {torch.backends.mps.is_available()}')"
```

### 1.5 Install Training Dependencies
```bash
# Core dependencies
pip install transformers==4.40.0
pip install datasets==2.18.0
pip install accelerate==0.27.0
pip install peft==0.10.0
pip install bitsandbytes  # May need special M4 build

# Additional requirements
pip install pillow tqdm tensorboard requests pandas numpy
```

## Phase 2: Data Preparation (5 minutes)

### 2.1 Verify Dataset Files
```bash
# Check training data exists
ls -la data/
# Should contain:
# - train.json (10,511 samples)
# - validation.json (2,628 samples)
# - dataset_statistics.json
```

### 2.2 Validate Data Format
```python
# Quick validation script
python -c "
import json
with open('data/train.json', 'r') as f:
    data = json.load(f)
    print(f'Training samples: {len(data)}')
    print(f'Sample keys: {data[0].keys()}')
"
```

## Phase 3: Model Training (30-60 minutes)

### 3.1 Configure Training Parameters

Create `config.yaml`:
```yaml
model:
  name: "HuggingFaceTB/SmolVLM-500M-Instruct"
  quantization: 4bit  # Reduces memory from 2GB to ~500MB
  
training:
  epochs: 3
  batch_size: 2  # Small for memory efficiency
  gradient_accumulation: 8  # Effective batch of 16
  learning_rate: 2e-4
  warmup_steps: 100
  
optimization:
  use_mps: true  # Metal Performance Shaders
  mixed_precision: fp16
  gradient_checkpointing: true
  
lora:
  rank: 16
  alpha: 32
  dropout: 0.1
  target_modules: ["q_proj", "v_proj", "k_proj", "o_proj"]
```

### 3.2 Start Training

```bash
# Basic training
python train_on_m4.py \
  --data-dir ./data \
  --output-dir ./output \
  --config ./config.yaml

# With monitoring
python train_on_m4.py \
  --data-dir ./data \
  --output-dir ./output \
  --tensorboard \
  --save-steps 500 \
  --eval-steps 100
```

### 3.3 Monitor Training Progress

**Terminal Monitoring**:
```bash
# Watch training logs
tail -f output/training.log
```

**TensorBoard Monitoring**:
```bash
# In a new terminal
tensorboard --logdir ./output/logs --port 6006
# Open browser to http://localhost:6006
```

**System Monitoring**:
```bash
# Open Activity Monitor
open -a "Activity Monitor"
# Watch Memory Pressure and GPU History
```

### Expected Metrics During Training:
- **Memory Usage**: 12-16GB of 24GB
- **Training Speed**: ~10-15 iterations/second
- **Temperature**: M4 may warm up but should stay under 90°C
- **Loss Progression**: Should decrease from ~2.5 to ~0.5

## Phase 4: Model Export (10 minutes)

### 4.1 Export Trained Model

```bash
# Export for CPU deployment on Fedora
python export_model.py \
  --model-dir ./output \
  --export-dir ./export \
  --target-device cpu \
  --quantize int8
```

### 4.2 Create Export Package

Create `export_model.py`:
```python
#!/usr/bin/env python3
import torch
from transformers import AutoModelForImageTextToText, AutoProcessor
from pathlib import Path
import shutil

def export_for_fedora(model_dir, export_dir):
    """Export model optimized for Fedora 42 CPU inference."""
    
    print("Loading trained model...")
    model = AutoModelForImageTextToText.from_pretrained(
        model_dir,
        torch_dtype=torch.float32,  # FP32 for CPU
        device_map="cpu"
    )
    
    processor = AutoProcessor.from_pretrained(model_dir)
    
    # Create export directory
    export_path = Path(export_dir) / "smolvlm_pokemon_finetuned"
    export_path.mkdir(parents=True, exist_ok=True)
    
    # Save model
    print("Saving model...")
    model.save_pretrained(
        export_path,
        safe_serialization=True,
        max_shard_size="500MB"  # Smaller shards for easier transfer
    )
    
    # Save processor
    processor.save_pretrained(export_path)
    
    # Create metadata
    metadata = {
        "model": "SmolVLM-500M",
        "finetuned": "Pokemon Cards",
        "samples": 13139,
        "training_device": "Apple M4",
        "target_device": "Intel CPU (Fedora 42)",
        "expected_inference": "2-3 seconds"
    }
    
    import json
    with open(export_path / "training_metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)
    
    # Create tar.gz for transfer
    print("Creating transfer package...")
    import tarfile
    tar_path = Path(export_dir) / "smolvlm_fedora.tar.gz"
    with tarfile.open(tar_path, "w:gz") as tar:
        tar.add(export_path, arcname="smolvlm_pokemon")
    
    size_mb = tar_path.stat().st_size / (1024 * 1024)
    print(f"✅ Export complete: {tar_path} ({size_mb:.1f} MB)")
    
    return tar_path

if __name__ == "__main__":
    export_for_fedora("./output", "./export")
```

### 4.3 Verify Export

```bash
# Check export contents
tar -tzf export/smolvlm_fedora.tar.gz | head -20

# Verify model files
ls -lh export/smolvlm_pokemon_finetuned/
# Should see:
# - config.json
# - model.safetensors (or pytorch_model.bin)
# - tokenizer files
# - preprocessor_config.json
```

## Phase 5: Transfer to Fedora 42 (5 minutes)

### 5.1 Transfer Methods

**Option A: Direct SCP**
```bash
# From M4 to Fedora
scp export/smolvlm_fedora.tar.gz user@fedora-ip:/home/profusionai/CardMint/models/
```

**Option B: Via Cloud Storage**
```bash
# Upload to cloud
curl -T export/smolvlm_fedora.tar.gz https://transfer.sh/smolvlm.tar.gz

# On Fedora, download
wget https://transfer.sh/[code]/smolvlm.tar.gz
```

**Option C: Via USB Drive**
```bash
# Copy to USB
cp export/smolvlm_fedora.tar.gz /Volumes/USB_DRIVE/

# On Fedora
cp /media/USB_DRIVE/smolvlm_fedora.tar.gz ~/CardMint/models/
```

### 5.2 Deploy on Fedora

On the Fedora 42 system:
```bash
cd /home/profusionai/CardMint/models
tar -xzf smolvlm_fedora.tar.gz
mv smolvlm_pokemon smolvlm_finetuned

# Update service configuration
sed -i 's/smolvlm/smolvlm_finetuned/g' ../src/ml/smolvlm_optimized_service.py

# Restart service
systemctl restart cardmint-vlm
```

## Optimization Tips for M4

### Memory Management
```python
# Enable memory efficient attention
model.config.use_memory_efficient_attention = True

# Use gradient checkpointing to trade compute for memory
model.gradient_checkpointing_enable()

# Clear cache periodically
import gc
gc.collect()
torch.mps.empty_cache()  # MPS cache
```

### Performance Tuning
```python
# Optimal settings for M4
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.7"
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

# Use native Apple optimizations
torch.backends.mps.enable_fast_math = True
```

### Batch Size Selection
- **2GB model**: batch_size=4 feasible
- **With 4-bit quantization**: batch_size=8-16 feasible
- **Monitor memory pressure**: Keep yellow or green

## Troubleshooting

### Issue: "MPS backend out of memory"
```bash
# Reduce batch size
python train_on_m4.py --batch-size 1 --gradient-accumulation 16
```

### Issue: "Module 'bitsandbytes' has no attribute..."
```bash
# Install M1/M2/M3/M4 compatible version
pip uninstall bitsandbytes
pip install bitsandbytes --no-deps
```

### Issue: Training very slow
```python
# Check MPS is being used
import torch
print(torch.backends.mps.is_available())  # Should be True
print(torch.backends.mps.is_built())      # Should be True
```

### Issue: Model not learning (loss not decreasing)
```python
# Adjust learning rate
# Try: 5e-5, 1e-4, or 5e-4
# Check data loading is correct
```

## Expected Results

### Training Metrics
- **Final Loss**: 0.3-0.6
- **Validation Accuracy**: 85-95%
- **Training Time**: 30-60 minutes
- **Model Size**: ~500MB (quantized)

### Inference Performance (Fedora)
- **First inference**: 3-4 seconds (model loading)
- **Subsequent**: 1-2 seconds
- **With caching**: <100ms for duplicates
- **Memory usage**: 2-3GB

## Final Checklist

- [ ] Python 3.10 or 3.11 installed
- [ ] Virtual environment created and activated
- [ ] PyTorch with MPS support installed
- [ ] Training data verified (13,139 samples)
- [ ] Training completed (loss < 0.6)
- [ ] Model exported to tar.gz
- [ ] Transfer to Fedora successful
- [ ] Service restarted with new model
- [ ] Test inference working (<3 seconds)

## Support Notes

- M4 can train effectively with its Neural Engine
- 24GB unified memory handles full model without issues
- Training is 5-10x faster than CPU-only
- Metal acceleration provides near-GPU performance
- Export must target CPU for Fedora deployment

---

*Document prepared for CardMint VLM optimization project*
*Target: Sub-3 second inference on Fedora 42*
*Training accelerator: MacBook Pro M4 24GB*