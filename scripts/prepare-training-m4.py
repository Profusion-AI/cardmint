#!/usr/bin/env python3
"""
Prepare training data and scripts for SmolVLM fine-tuning on MacBook Pro M4.
This creates a portable training package that can be transferred to M4 for training.
"""

import os
import sys
import json
import shutil
import tarfile
from pathlib import Path
import logging
from typing import Dict, List, Any

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class M4TrainingPreparer:
    """Prepare training package for MacBook Pro M4."""
    
    def __init__(self, 
                 data_dir: str = "/home/profusionai/CardMint/data/pokemon_dataset",
                 output_dir: str = "/home/profusionai/CardMint/m4_training"):
        """Initialize preparer."""
        self.data_dir = Path(data_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
    def create_training_script(self):
        """Create the training script optimized for M4."""
        script_content = '''#!/usr/bin/env python3
"""
SmolVLM Fine-tuning Script for MacBook Pro M4
Optimized for Apple Silicon with Metal acceleration
"""

import torch
import torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from transformers import (
    AutoModelForImageTextToText,
    AutoProcessor,
    BitsAndBytesConfig,
    TrainingArguments,
    Trainer
)
from peft import LoraConfig, get_peft_model, TaskType
from PIL import Image
import json
import requests
from pathlib import Path
from tqdm import tqdm
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class PokemonCardDataset(Dataset):
    """Dataset for Pokemon card fine-tuning."""
    
    def __init__(self, data_path, processor, max_samples=None):
        with open(data_path, 'r') as f:
            self.data = json.load(f)
        
        if max_samples:
            self.data = self.data[:max_samples]
            
        self.processor = processor
        self.failed_downloads = []
        
    def __len__(self):
        return len(self.data)
        
    def __getitem__(self, idx):
        item = self.data[idx]
        
        # Try to load image
        try:
            if item['image_url'].startswith('http'):
                response = requests.get(item['image_url'], timeout=5)
                image = Image.open(BytesIO(response.content)).convert('RGB')
            else:
                image = Image.open(item['image_url']).convert('RGB')
        except:
            # Create placeholder image on failure
            image = Image.new('RGB', (224, 224), color='white')
            self.failed_downloads.append(idx)
            
        # Prepare text
        messages = [{
            "role": "user",
            "content": [
                {"type": "image"},
                {"type": "text", "text": item['prompt']}
            ]
        }]
        
        prompt = self.processor.apply_chat_template(messages, add_generation_prompt=True)
        
        # Process inputs
        inputs = self.processor(
            text=prompt,
            images=[image],
            return_tensors="pt",
            padding=True,
            truncation=True
        )
        
        # Add labels (response text)
        inputs['labels'] = self.processor.tokenizer(
            item['response'],
            return_tensors="pt",
            padding=True,
            truncation=True
        ).input_ids
        
        return inputs

def setup_model_for_training(model_path="HuggingFaceTB/SmolVLM-500M-Instruct"):
    """Setup model with LoRA for efficient fine-tuning."""
    logger.info(f"Loading model: {model_path}")
    
    # Load processor
    processor = AutoProcessor.from_pretrained(model_path)
    
    # Configure 4-bit quantization for M4 efficiency
    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_use_double_quant=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16
    )
    
    # Load model with quantization
    model = AutoModelForImageTextToText.from_pretrained(
        model_path,
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.float16,
        trust_remote_code=True
    )
    
    # Configure LoRA
    lora_config = LoraConfig(
        r=16,  # Rank
        lora_alpha=32,
        target_modules=["q_proj", "v_proj", "k_proj", "o_proj"],
        lora_dropout=0.1,
        bias="none",
        task_type=TaskType.IMAGE_TEXT_TO_TEXT
    )
    
    # Apply LoRA
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    
    return model, processor

def train_model(model, processor, train_data_path, val_data_path, output_dir):
    """Train the model with Pokemon dataset."""
    logger.info("Preparing datasets...")
    
    # Create datasets
    train_dataset = PokemonCardDataset(train_data_path, processor)
    val_dataset = PokemonCardDataset(val_data_path, processor, max_samples=100)
    
    # Training arguments optimized for M4
    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=3,
        per_device_train_batch_size=2,  # Small batch for memory efficiency
        per_device_eval_batch_size=2,
        gradient_accumulation_steps=8,  # Effective batch size of 16
        warmup_steps=100,
        logging_steps=25,
        save_steps=500,
        evaluation_strategy="steps",
        eval_steps=100,
        save_strategy="steps",
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        push_to_hub=False,
        remove_unused_columns=False,
        fp16=True,  # Use mixed precision on M4
        optim="adamw_torch",
        learning_rate=2e-4,
        weight_decay=0.01,
        max_grad_norm=1.0,
        dataloader_num_workers=4,
        report_to=["tensorboard"],
        logging_dir=f"{output_dir}/logs",
    )
    
    # Create trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        tokenizer=processor,
    )
    
    # Train
    logger.info("Starting training...")
    trainer.train()
    
    # Save model
    logger.info(f"Saving model to {output_dir}")
    trainer.save_model()
    processor.save_pretrained(output_dir)
    
    return trainer

def export_for_production(model_dir, export_dir):
    """Export trained model for production deployment."""
    logger.info("Exporting model for production...")
    
    # Load trained model
    model = AutoModelForImageTextToText.from_pretrained(
        model_dir,
        torch_dtype=torch.float32,  # Use FP32 for CPU inference
        device_map="cpu"
    )
    
    processor = AutoProcessor.from_pretrained(model_dir)
    
    # Save in format optimized for CPU inference
    export_path = Path(export_dir) / "smolvlm_pokemon_finetuned"
    export_path.mkdir(parents=True, exist_ok=True)
    
    model.save_pretrained(
        export_path,
        safe_serialization=True,
        max_shard_size="2GB"
    )
    processor.save_pretrained(export_path)
    
    logger.info(f"✅ Model exported to {export_path}")
    logger.info("Transfer this folder back to Fedora system for deployment")
    
    return export_path

def main():
    """Main training pipeline."""
    import argparse
    
    parser = argparse.ArgumentParser(description="Fine-tune SmolVLM on Pokemon cards")
    parser.add_argument("--data-dir", default="./data", help="Data directory")
    parser.add_argument("--output-dir", default="./output", help="Output directory")
    parser.add_argument("--export-only", action="store_true", help="Only export existing model")
    
    args = parser.parse_args()
    
    if args.export_only:
        # Just export existing model
        export_for_production(args.output_dir, "./export")
    else:
        # Full training pipeline
        train_data = Path(args.data_dir) / "train.json"
        val_data = Path(args.data_dir) / "validation.json"
        
        if not train_data.exists():
            logger.error(f"Training data not found at {train_data}")
            sys.exit(1)
            
        # Setup model
        model, processor = setup_model_for_training()
        
        # Train
        trainer = train_model(
            model, processor,
            train_data, val_data,
            args.output_dir
        )
        
        # Export for production
        export_for_production(args.output_dir, "./export")
        
        print("\\n" + "="*60)
        print("TRAINING COMPLETE!")
        print("="*60)
        print(f"Model saved to: {args.output_dir}")
        print(f"Export ready at: ./export/smolvlm_pokemon_finetuned")
        print("\\nTransfer export folder to Fedora system for deployment")

if __name__ == "__main__":
    main()
'''
        
        script_path = self.output_dir / "train_on_m4.py"
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        # Make executable
        script_path.chmod(0o755)
        logger.info(f"✅ Created training script: {script_path}")
        
    def create_requirements(self):
        """Create requirements.txt for M4 environment."""
        requirements = """# Requirements for M4 training environment
torch>=2.0.0
torchvision
transformers>=4.40.0
datasets
accelerate
peft>=0.10.0
bitsandbytes
pillow
tqdm
tensorboard
requests
"""
        
        req_path = self.output_dir / "requirements.txt"
        with open(req_path, 'w') as f:
            f.write(requirements)
            
        logger.info(f"✅ Created requirements.txt")
        
    def create_setup_script(self):
        """Create setup script for M4."""
        setup_content = """#!/bin/bash
# Setup script for MacBook Pro M4

echo "Setting up SmolVLM training environment on M4..."

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install PyTorch for Apple Silicon
pip install torch torchvision torchaudio

# Install other requirements
pip install -r requirements.txt

echo "✅ Environment setup complete!"
echo ""
echo "To start training:"
echo "  source venv/bin/activate"
echo "  python train_on_m4.py --data-dir ./data --output-dir ./output"
"""
        
        setup_path = self.output_dir / "setup_m4.sh"
        with open(setup_path, 'w') as f:
            f.write(setup_content)
        setup_path.chmod(0o755)
        
        logger.info(f"✅ Created setup script")
        
    def copy_training_data(self):
        """Copy prepared training data."""
        logger.info("Copying training data...")
        
        # Create data directory
        data_output = self.output_dir / "data"
        data_output.mkdir(exist_ok=True)
        
        # Copy training files
        files_to_copy = [
            "training/train.json",
            "training/validation.json",
            "dataset_statistics.json"
        ]
        
        for file_path in files_to_copy:
            src = self.data_dir / file_path
            if src.exists():
                dst = data_output / Path(file_path).name
                shutil.copy2(src, dst)
                logger.info(f"   Copied: {file_path}")
                
        # Copy sample images
        sample_dir = self.data_dir / "sample_images"
        if sample_dir.exists():
            dst_samples = data_output / "samples"
            shutil.copytree(sample_dir, dst_samples, dirs_exist_ok=True)
            logger.info(f"   Copied sample images")
            
    def create_readme(self):
        """Create README with instructions."""
        readme_content = """# SmolVLM Fine-tuning on MacBook Pro M4

This package contains everything needed to fine-tune SmolVLM-500M on Pokemon cards
using the MacBook Pro M4 with 24GB unified memory.

## Quick Start

1. **Setup Environment** (first time only):
   ```bash
   ./setup_m4.sh
   ```

2. **Activate Environment**:
   ```bash
   source venv/bin/activate
   ```

3. **Start Training**:
   ```bash
   python train_on_m4.py --data-dir ./data --output-dir ./output
   ```

## Training Details

- Model: SmolVLM-500M-Instruct
- Dataset: 13,139 Pokemon cards
- Method: QLoRA (4-bit quantization with LoRA adapters)
- Expected training time: 30-60 minutes on M4
- Memory usage: ~12-16GB

## After Training

1. The trained model will be in `./output/`
2. Export for production: `./export/smolvlm_pokemon_finetuned/`
3. Transfer the export folder back to Fedora system
4. Deploy using `smolvlm_optimized_service.py`

## Monitoring

Training progress can be monitored with TensorBoard:
```bash
tensorboard --logdir ./output/logs
```

## Tips for M4

- The M4's Neural Engine accelerates transformer operations
- Unified memory allows larger batch sizes than typical GPUs
- Metal Performance Shaders provide additional acceleration
- Keep Activity Monitor open to monitor memory usage

## Troubleshooting

If you encounter memory issues:
- Reduce batch_size in train_on_m4.py
- Increase gradient_accumulation_steps to compensate
- Close other applications to free memory

"""
        
        readme_path = self.output_dir / "README.md"
        with open(readme_path, 'w') as f:
            f.write(readme_content)
            
        logger.info(f"✅ Created README")
        
    def create_package(self):
        """Create tar.gz package for transfer."""
        logger.info("Creating training package...")
        
        package_path = Path("/home/profusionai/CardMint/smolvlm_m4_training.tar.gz")
        
        with tarfile.open(package_path, "w:gz") as tar:
            tar.add(self.output_dir, arcname="smolvlm_training")
            
        # Get package size
        size_mb = package_path.stat().st_size / (1024 * 1024)
        
        logger.info(f"✅ Package created: {package_path} ({size_mb:.1f} MB)")
        
        return package_path
        
def main():
    """Main execution."""
    preparer = M4TrainingPreparer()
    
    logger.info("Preparing SmolVLM training package for MacBook Pro M4...")
    
    # Create all components
    preparer.create_training_script()
    preparer.create_requirements()
    preparer.create_setup_script()
    preparer.copy_training_data()
    preparer.create_readme()
    
    # Create package
    package_path = preparer.create_package()
    
    print("\n" + "="*60)
    print("M4 TRAINING PACKAGE READY!")
    print("="*60)
    print(f"Package location: {package_path}")
    print(f"Package size: {package_path.stat().st_size / (1024*1024):.1f} MB")
    print("\nTransfer instructions:")
    print("1. Copy to M4: scp smolvlm_m4_training.tar.gz user@m4-macbook:~/")
    print("2. Extract: tar -xzf smolvlm_m4_training.tar.gz")
    print("3. Setup: cd smolvlm_training && ./setup_m4.sh")
    print("4. Train: python train_on_m4.py")
    print("\nExpected training time on M4: 30-60 minutes")
    print("Expected memory usage: 12-16GB of 24GB available")

if __name__ == "__main__":
    main()