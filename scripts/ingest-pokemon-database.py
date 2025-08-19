#!/usr/bin/env python3
"""
Ingest Pokemon cards dataset into PostgreSQL for validation enhancement.
This script loads the downloaded dataset into the production database.
"""

import os
import sys
import json
import pandas as pd
import psycopg2
from psycopg2.extras import execute_batch
from pathlib import Path
import logging
from typing import Dict, List, Any, Optional
import hashlib
from tqdm import tqdm

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class PokemonDatabaseIngester:
    """Ingest Pokemon cards into PostgreSQL database."""
    
    def __init__(self, 
                 data_dir: str = "/home/profusionai/CardMint/data/pokemon_dataset",
                 db_config: Optional[Dict] = None):
        """Initialize ingester with database connection."""
        self.data_dir = Path(data_dir)
        
        # Database configuration (use env vars or defaults)
        self.db_config = db_config or {
            'host': os.getenv('DB_HOST', 'localhost'),
            'port': int(os.getenv('DB_PORT', '16380')),  # Fly proxy port
            'database': os.getenv('DB_NAME', 'cardmint'),
            'user': os.getenv('DB_USER', 'postgres'),
            'password': os.getenv('DB_PASSWORD', '')
        }
        
        self.conn = None
        self.cursor = None
        
    def connect(self):
        """Establish database connection."""
        try:
            logger.info(f"Connecting to database at {self.db_config['host']}:{self.db_config['port']}")
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor()
            
            # Test connection
            self.cursor.execute("SELECT version()")
            version = self.cursor.fetchone()[0]
            logger.info(f"✅ Connected to: {version}")
            
            # Check if pgvector extension is available
            self.cursor.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM pg_extension WHERE extname = 'vector'
                )
            """)
            has_vector = self.cursor.fetchone()[0]
            if not has_vector:
                logger.warning("⚠️  pgvector extension not installed. Embeddings will be skipped.")
                logger.info("   To install: CREATE EXTENSION vector;")
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to connect to database: {e}")
            logger.info("Make sure Fly proxy is running: fly proxy 16380:5432 -a cardmint-db")
            return False
            
    def create_tables(self):
        """Create tables if they don't exist."""
        logger.info("Creating tables if needed...")
        
        try:
            # Read and execute migration file
            migration_path = Path(__file__).parent.parent / "src/storage/migrations/005_pokemon_known_cards.sql"
            
            if migration_path.exists():
                with open(migration_path, 'r') as f:
                    migration_sql = f.read()
                    
                # Execute migration
                self.cursor.execute(migration_sql)
                self.conn.commit()
                logger.info("✅ Database schema created/updated")
            else:
                # Fallback: Create basic table
                self.cursor.execute("""
                    CREATE TABLE IF NOT EXISTS known_pokemon_cards (
                        id VARCHAR(50) PRIMARY KEY,
                        name VARCHAR(255) NOT NULL,
                        hp INTEGER,
                        set_name VARCHAR(255),
                        caption TEXT,
                        image_url TEXT,
                        card_number VARCHAR(20),
                        has_attacks BOOLEAN DEFAULT false,
                        has_ability BOOLEAN DEFAULT false,
                        is_ex BOOLEAN DEFAULT false,
                        is_gx BOOLEAN DEFAULT false,
                        is_vmax BOOLEAN DEFAULT false,
                        is_vstar BOOLEAN DEFAULT false,
                        name_normalized VARCHAR(255),
                        match_count INTEGER DEFAULT 0,
                        confidence_boost FLOAT DEFAULT 0.0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                self.conn.commit()
                logger.info("✅ Basic table structure created")
                
        except Exception as e:
            logger.error(f"Failed to create tables: {e}")
            self.conn.rollback()
            raise
            
    def load_dataset(self) -> pd.DataFrame:
        """Load the processed dataset."""
        csv_path = self.data_dir / "pokemon_cards_processed.csv"
        
        if not csv_path.exists():
            logger.error(f"Dataset not found at {csv_path}")
            logger.info("Run download-pokemon-dataset.py first")
            sys.exit(1)
            
        logger.info(f"Loading dataset from {csv_path}")
        df = pd.read_csv(csv_path)
        logger.info(f"✅ Loaded {len(df)} cards")
        
        return df
        
    def prepare_card_data(self, row: pd.Series) -> Dict[str, Any]:
        """Prepare a single card record for insertion."""
        # Normalize name for matching
        name_normalized = row['name'].lower().strip() if pd.notna(row['name']) else ''
        name_normalized = ''.join(c for c in name_normalized if c.isalnum() or c.isspace())
        
        return {
            'id': row['id'],
            'name': row['name'],
            'hp': int(row['hp']) if pd.notna(row['hp']) else None,
            'set_name': row['set_name'] if pd.notna(row['set_name']) else None,
            'caption': row['caption'] if pd.notna(row['caption']) else None,
            'image_url': row['image_url'] if pd.notna(row['image_url']) else None,
            'card_number': row.get('card_number'),
            'has_attacks': bool(row.get('has_attacks', False)),
            'has_ability': bool(row.get('has_ability', False)),
            'is_ex': bool(row.get('is_ex', False)),
            'is_gx': bool(row.get('is_gx', False)),
            'is_vmax': bool(row.get('is_vmax', False)),
            'is_vstar': bool(row.get('is_vstar', False)),
            'name_normalized': name_normalized,
            'match_count': 0,
            'confidence_boost': 0.0
        }
        
    def insert_cards(self, df: pd.DataFrame, batch_size: int = 100):
        """Insert cards into database in batches."""
        logger.info(f"Inserting {len(df)} cards into database...")
        
        # Prepare insert query
        insert_query = """
            INSERT INTO known_pokemon_cards (
                id, name, hp, set_name, caption, image_url,
                card_number, has_attacks, has_ability,
                is_ex, is_gx, is_vmax, is_vstar,
                name_normalized, match_count, confidence_boost
            ) VALUES (
                %(id)s, %(name)s, %(hp)s, %(set_name)s, %(caption)s, %(image_url)s,
                %(card_number)s, %(has_attacks)s, %(has_ability)s,
                %(is_ex)s, %(is_gx)s, %(is_vmax)s, %(is_vstar)s,
                %(name_normalized)s, %(match_count)s, %(confidence_boost)s
            )
            ON CONFLICT (id) DO UPDATE SET
                name = EXCLUDED.name,
                hp = EXCLUDED.hp,
                set_name = EXCLUDED.set_name,
                caption = EXCLUDED.caption,
                image_url = EXCLUDED.image_url,
                updated_at = CURRENT_TIMESTAMP
        """
        
        # Process in batches
        total_inserted = 0
        failed_cards = []
        
        for i in tqdm(range(0, len(df), batch_size), desc="Inserting batches"):
            batch = df.iloc[i:i+batch_size]
            batch_data = []
            
            for _, row in batch.iterrows():
                try:
                    card_data = self.prepare_card_data(row)
                    batch_data.append(card_data)
                except Exception as e:
                    logger.warning(f"Failed to prepare card {row.get('id', 'unknown')}: {e}")
                    failed_cards.append(row.get('id', 'unknown'))
                    
            if batch_data:
                try:
                    execute_batch(self.cursor, insert_query, batch_data)
                    total_inserted += len(batch_data)
                except Exception as e:
                    logger.error(f"Failed to insert batch: {e}")
                    self.conn.rollback()
                    
        # Commit all changes
        self.conn.commit()
        
        logger.info(f"✅ Inserted {total_inserted} cards successfully")
        if failed_cards:
            logger.warning(f"⚠️  Failed to insert {len(failed_cards)} cards: {failed_cards[:5]}...")
            
        return total_inserted
        
    def create_indexes(self):
        """Create database indexes for performance."""
        logger.info("Creating indexes for optimal performance...")
        
        indexes = [
            "CREATE INDEX IF NOT EXISTS idx_known_name ON known_pokemon_cards(name)",
            "CREATE INDEX IF NOT EXISTS idx_known_normalized ON known_pokemon_cards(name_normalized)",
            "CREATE INDEX IF NOT EXISTS idx_known_set ON known_pokemon_cards(set_name)",
            "CREATE INDEX IF NOT EXISTS idx_known_number ON known_pokemon_cards(card_number)",
            "CREATE INDEX IF NOT EXISTS idx_known_special ON known_pokemon_cards(is_ex, is_gx, is_vmax)",
            "CREATE INDEX IF NOT EXISTS idx_known_match_count ON known_pokemon_cards(match_count DESC)",
        ]
        
        for index_sql in indexes:
            try:
                self.cursor.execute(index_sql)
                logger.info(f"   Created: {index_sql.split('idx_')[1].split(' ')[0]}")
            except Exception as e:
                logger.warning(f"   Index creation failed: {e}")
                
        self.conn.commit()
        logger.info("✅ Indexes created")
        
    def add_common_aliases(self):
        """Add common card name aliases and variations."""
        logger.info("Adding common card aliases...")
        
        # Common variations
        aliases = [
            ('base-4', 'Charizard', 'Zard', 'nickname'),
            ('base-58', 'Pikachu', 'Pika', 'nickname'),
            ('base-15', 'Venusaur', 'Venasaur', 'typo'),
            ('base-2', 'Ivysaur', 'Ivysour', 'typo'),
        ]
        
        insert_alias = """
            INSERT INTO card_name_aliases (card_id, alias, alias_type, confidence)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (card_id, alias) DO NOTHING
        """
        
        for card_id, name, alias, alias_type in aliases:
            try:
                self.cursor.execute(insert_alias, (card_id, alias, alias_type, 0.95))
            except:
                pass  # Ignore if card doesn't exist
                
        self.conn.commit()
        logger.info("✅ Aliases added")
        
    def verify_ingestion(self):
        """Verify the data was ingested correctly."""
        logger.info("Verifying data ingestion...")
        
        # Check total count
        self.cursor.execute("SELECT COUNT(*) FROM known_pokemon_cards")
        total = self.cursor.fetchone()[0]
        
        # Check some statistics
        self.cursor.execute("""
            SELECT 
                COUNT(DISTINCT name) as unique_names,
                COUNT(DISTINCT set_name) as unique_sets,
                AVG(hp) as avg_hp,
                SUM(CASE WHEN is_ex THEN 1 ELSE 0 END) as ex_cards,
                SUM(CASE WHEN is_gx THEN 1 ELSE 0 END) as gx_cards,
                SUM(CASE WHEN is_vmax THEN 1 ELSE 0 END) as vmax_cards
            FROM known_pokemon_cards
        """)
        
        stats = self.cursor.fetchone()
        
        print("\n" + "="*60)
        print("DATABASE INGESTION SUMMARY")
        print("="*60)
        print(f"Total cards: {total:,}")
        print(f"Unique Pokemon: {stats[0]:,}")
        print(f"Card sets: {stats[1]:,}")
        print(f"Average HP: {stats[2]:.1f}" if stats[2] else "Average HP: N/A")
        print(f"Special cards: EX={stats[3]}, GX={stats[4]}, VMAX={stats[5]}")
        
        # Sample query
        self.cursor.execute("""
            SELECT id, name, hp, set_name 
            FROM known_pokemon_cards 
            WHERE name LIKE '%Pikachu%'
            LIMIT 5
        """)
        
        print("\nSample Pikachu cards:")
        for row in self.cursor.fetchall():
            print(f"  - {row[1]} (HP: {row[2]}) from {row[3]} [{row[0]}]")
            
        return total
        
    def close(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Database connection closed")
        
def main():
    """Main execution function."""
    ingester = PokemonDatabaseIngester()
    
    try:
        # Connect to database
        if not ingester.connect():
            logger.error("Failed to connect to database")
            logger.info("\nTo start Fly proxy:")
            logger.info("  fly proxy 16380:5432 -a cardmint-db")
            sys.exit(1)
            
        # Create tables
        ingester.create_tables()
        
        # Load dataset
        df = ingester.load_dataset()
        
        # Insert cards
        total = ingester.insert_cards(df)
        
        # Create indexes
        ingester.create_indexes()
        
        # Add aliases
        ingester.add_common_aliases()
        
        # Verify
        ingester.verify_ingestion()
        
        print("\n✅ Dataset successfully ingested into database!")
        print("\nNext steps:")
        print("1. Test validation: python scripts/test-dataset-validation.py")
        print("2. Fine-tune model: python scripts/finetune-smolvlm.py")
        print("3. Deploy service: python src/ml/smolvlm_optimized_service.py")
        
    except Exception as e:
        logger.error(f"Ingestion failed: {e}")
        sys.exit(1)
        
    finally:
        ingester.close()

if __name__ == "__main__":
    main()