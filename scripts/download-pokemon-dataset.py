#!/usr/bin/env python3
"""
Download and process TheFusion21/PokemonCards dataset from HuggingFace
for VLM fine-tuning and validation enhancement.
"""

import os
import sys
import json
import pandas as pd
from pathlib import Path
import logging
from typing import Dict, List, Any
import requests
from tqdm import tqdm

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class PokemonDatasetDownloader:
    """Download and process Pokemon cards dataset for CardMint integration."""
    
    def __init__(self, data_dir: str = "/home/profusionai/CardMint/data/pokemon_dataset"):
        """Initialize downloader with data directory."""
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        
    def download_dataset(self) -> Path:
        """Download the Pokemon cards dataset from HuggingFace."""
        logger.info("Downloading TheFusion21/PokemonCards dataset...")
        
        csv_path = self.data_dir / "pokemon_cards.csv"
        
        if csv_path.exists():
            logger.info(f"Dataset already exists at {csv_path}")
            return csv_path
            
        try:
            # Try using datasets library first
            try:
                from datasets import load_dataset
                logger.info("Using datasets library to download...")
                
                dataset = load_dataset("TheFusion21/PokemonCards", split="train")
                df = dataset.to_pandas()
                df.to_csv(csv_path, index=False)
                logger.info(f"✅ Dataset downloaded to {csv_path}")
                return csv_path
                
            except ImportError:
                logger.warning("datasets library not available, trying direct download...")
                
                # Alternative: Download CSV directly from HuggingFace
                csv_url = "https://huggingface.co/datasets/TheFusion21/PokemonCards/raw/main/train.csv"
                response = requests.get(csv_url, stream=True)
                response.raise_for_status()
                
                with open(csv_path, 'wb') as f:
                    for chunk in response.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
                            
                logger.info(f"✅ Dataset downloaded to {csv_path}")
                return csv_path
            
        except Exception as e:
            logger.error(f"Failed to download dataset: {e}")
            raise
            
    def load_and_process(self, csv_path: Path) -> pd.DataFrame:
        """Load and process the dataset."""
        logger.info("Loading dataset from CSV file...")
        
        try:
            # Load CSV file
            df = pd.read_csv(csv_path)
            logger.info(f"✅ Loaded {len(df)} Pokemon cards")
            
            # Display dataset info
            logger.info(f"Columns: {df.columns.tolist()}")
            logger.info(f"Sample entry:\n{df.iloc[0].to_dict()}")
            
            # Process and clean data
            df = self.clean_dataset(df)
            
            # Save processed version
            csv_path = self.data_dir / "pokemon_cards_processed.csv"
            df.to_csv(csv_path, index=False)
            logger.info(f"✅ Saved processed dataset to {csv_path}")
            
            # Save as JSON for easy access
            json_path = self.data_dir / "pokemon_cards.json"
            # Convert numpy types to native Python types for JSON serialization
            df_json = df.copy()
            for col in df_json.columns:
                if df_json[col].dtype == 'int64':
                    df_json[col] = df_json[col].astype(int)
            df_json.to_json(json_path, orient='records', indent=2)
            logger.info(f"✅ Saved JSON version to {json_path}")
            
            return df
            
        except Exception as e:
            logger.error(f"Failed to process dataset: {e}")
            raise
            
    def clean_dataset(self, df: pd.DataFrame) -> pd.DataFrame:
        """Clean and enhance the dataset."""
        logger.info("Cleaning and enhancing dataset...")
        
        # Ensure required columns exist
        required_cols = ['id', 'name', 'hp', 'set_name', 'image_url', 'caption']
        
        for col in required_cols:
            if col not in df.columns:
                logger.warning(f"Column '{col}' not found, creating placeholder")
                df[col] = None
                
        # Clean HP values (convert to integer where possible)
        if 'hp' in df.columns:
            df['hp'] = pd.to_numeric(df['hp'], errors='coerce')
            
        # Extract card number from ID if present
        if 'id' in df.columns:
            df['card_number'] = df['id'].str.extract(r'(\d+)', expand=False)
            
        # Parse caption for additional features
        if 'caption' in df.columns:
            df['has_attacks'] = df['caption'].str.contains('Attack', case=False, na=False)
            df['has_ability'] = df['caption'].str.contains('Ability', case=False, na=False)
            df['is_ex'] = df['caption'].str.contains(r'\bEX\b', case=False, na=False)
            df['is_gx'] = df['caption'].str.contains(r'\bGX\b', case=False, na=False)
            df['is_vmax'] = df['caption'].str.contains(r'\bVMAX\b', case=False, na=False)
            
        # Remove duplicates
        initial_count = len(df)
        df = df.drop_duplicates(subset=['id'], keep='first')
        if len(df) < initial_count:
            logger.info(f"Removed {initial_count - len(df)} duplicate entries")
            
        logger.info(f"✅ Dataset cleaned: {len(df)} unique cards")
        return df
        
    def create_statistics(self, df: pd.DataFrame) -> Dict[str, Any]:
        """Generate statistics about the dataset."""
        stats = {
            'total_cards': int(len(df)),
            'unique_names': int(df['name'].nunique()) if 'name' in df.columns else 0,
            'unique_sets': int(df['set_name'].nunique()) if 'set_name' in df.columns else 0,
            'avg_hp': float(df['hp'].mean()) if 'hp' in df.columns else 0,
            'max_hp': int(df['hp'].max()) if 'hp' in df.columns and not pd.isna(df['hp'].max()) else 0,
            'special_cards': {
                'ex': int(df['is_ex'].sum()) if 'is_ex' in df.columns else 0,
                'gx': int(df['is_gx'].sum()) if 'is_gx' in df.columns else 0,
                'vmax': int(df['is_vmax'].sum()) if 'is_vmax' in df.columns else 0,
            },
            'sets': {k: int(v) for k, v in df['set_name'].value_counts().head(10).to_dict().items()} if 'set_name' in df.columns else {}
        }
        
        # Save statistics
        stats_path = self.data_dir / "dataset_statistics.json"
        with open(stats_path, 'w') as f:
            json.dump(stats, f, indent=2)
            
        logger.info(f"✅ Statistics saved to {stats_path}")
        return stats
        
    def prepare_for_training(self, df: pd.DataFrame) -> None:
        """Prepare dataset for VLM fine-tuning."""
        logger.info("Preparing dataset for VLM fine-tuning...")
        
        training_dir = self.data_dir / "training"
        training_dir.mkdir(exist_ok=True)
        
        # Create training format (image_path, caption pairs)
        training_data = []
        
        for _, row in df.iterrows():
            # Create structured prompt for VLM training
            prompt = f"Identify this Pokemon card. Name: {row['name']}"
            if pd.notna(row.get('hp')):
                prompt += f", HP: {row['hp']}"
            if pd.notna(row.get('set_name')):
                prompt += f", Set: {row['set_name']}"
            if pd.notna(row.get('card_number')):
                prompt += f", Number: {row['card_number']}"
                
            training_entry = {
                'id': row['id'],
                'image_url': row['image_url'],
                'prompt': prompt,
                'response': row['caption'] if pd.notna(row.get('caption')) else prompt,
                'metadata': {
                    'name': row['name'],
                    'hp': int(row['hp']) if pd.notna(row.get('hp')) else None,
                    'set': row['set_name']
                }
            }
            training_data.append(training_entry)
            
        # Split into train/validation sets (80/20)
        split_idx = int(len(training_data) * 0.8)
        train_data = training_data[:split_idx]
        val_data = training_data[split_idx:]
        
        # Save training sets
        train_path = training_dir / "train.json"
        val_path = training_dir / "validation.json"
        
        with open(train_path, 'w') as f:
            json.dump(train_data, f, indent=2)
            
        with open(val_path, 'w') as f:
            json.dump(val_data, f, indent=2)
            
        logger.info(f"✅ Training data prepared:")
        logger.info(f"   - Training set: {len(train_data)} samples → {train_path}")
        logger.info(f"   - Validation set: {len(val_data)} samples → {val_path}")
        
    def download_sample_images(self, df: pd.DataFrame, num_samples: int = 10) -> None:
        """Download sample images for testing."""
        logger.info(f"Downloading {num_samples} sample images for testing...")
        
        samples_dir = self.data_dir / "sample_images"
        samples_dir.mkdir(exist_ok=True)
        
        # Select diverse samples
        samples = df.sample(min(num_samples, len(df)))
        
        for idx, (_, row) in enumerate(samples.iterrows()):
            if pd.notna(row.get('image_url')):
                try:
                    response = requests.get(row['image_url'])
                    response.raise_for_status()
                    
                    image_path = samples_dir / f"{row['id']}.png"
                    with open(image_path, 'wb') as f:
                        f.write(response.content)
                        
                    logger.info(f"   Downloaded: {row['name']} → {image_path.name}")
                    
                except Exception as e:
                    logger.warning(f"   Failed to download {row['name']}: {e}")
                    
        logger.info(f"✅ Sample images saved to {samples_dir}")
        
def main():
    """Main execution function."""
    downloader = PokemonDatasetDownloader()
    
    try:
        # Step 1: Download dataset
        csv_path = downloader.download_dataset()
        
        # Step 2: Load and process
        df = downloader.load_and_process(csv_path)
        
        # Step 3: Generate statistics
        stats = downloader.create_statistics(df)
        
        # Print summary
        print("\n" + "="*60)
        print("POKEMON DATASET INTEGRATION SUMMARY")
        print("="*60)
        print(f"Total cards: {stats['total_cards']:,}")
        print(f"Unique Pokemon: {stats['unique_names']:,}")
        print(f"Card sets: {stats['unique_sets']}")
        print(f"Average HP: {stats['avg_hp']:.1f}")
        print(f"Special cards: EX={stats['special_cards']['ex']}, "
              f"GX={stats['special_cards']['gx']}, "
              f"VMAX={stats['special_cards']['vmax']}")
        
        # Step 4: Prepare for training
        downloader.prepare_for_training(df)
        
        # Step 5: Download sample images
        downloader.download_sample_images(df, num_samples=5)
        
        print("\n✅ Dataset integration complete!")
        print(f"📁 Data location: {downloader.data_dir}")
        print("\nNext steps:")
        print("1. Run: python scripts/ingest-pokemon-database.py")
        print("2. Run: python scripts/finetune-smolvlm.py")
        print("3. Test: python scripts/test-dataset-validation.py")
        
    except Exception as e:
        logger.error(f"Dataset integration failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()