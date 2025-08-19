#!/usr/bin/env python3
"""
Dataset Validation Service for SmolVLM
Enhances VLM predictions by validating against known Pokemon cards database.
Provides confidence boosting, fuzzy matching, and caching.
"""

import os
import sys
import time
import hashlib
import json
import re
from typing import Dict, Any, Optional, List, Tuple
from dataclasses import dataclass
import psycopg2
from psycopg2.extras import RealDictCursor
import logging
from difflib import SequenceMatcher
import numpy as np
from pathlib import Path

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

@dataclass
class ValidationResult:
    """Result from dataset validation."""
    matched: bool
    confidence: float
    match_type: str  # 'exact', 'fuzzy', 'similarity', 'none'
    card_id: Optional[str]
    card_name: Optional[str]
    adjustments: Dict[str, Any]
    processing_time_ms: float

class DatasetValidationService:
    """
    Validates VLM predictions against known Pokemon cards database.
    Improves accuracy by matching against 13,139 verified cards.
    """
    
    def __init__(self, 
                 db_config: Optional[Dict] = None,
                 cache_size: int = 1000,
                 fuzzy_threshold: float = 0.85):
        """
        Initialize validation service.
        
        Args:
            db_config: Database configuration
            cache_size: Size of in-memory cache
            fuzzy_threshold: Threshold for fuzzy matching (0-1)
        """
        self.db_config = db_config or {
            'host': os.getenv('DB_HOST', 'localhost'),
            'port': int(os.getenv('DB_PORT', '5432')),
            'database': os.getenv('DB_NAME', 'cardmint'),
            'user': os.getenv('DB_USER', 'cardmint'),
            'password': os.getenv('DB_PASSWORD', 'changeme')
        }
        
        self.cache_size = cache_size
        self.fuzzy_threshold = fuzzy_threshold
        
        # In-memory cache
        self.cache = {}
        self.known_cards = {}
        
        # Database connection
        self.conn = None
        self.cursor = None
        
        # Statistics
        self.stats = {
            'total_validations': 0,
            'exact_matches': 0,
            'fuzzy_matches': 0,
            'no_matches': 0,
            'cache_hits': 0,
            'avg_confidence_boost': 0.0
        }
        
        # Initialize
        self._connect_db()
        self._load_known_cards()
        
    def _connect_db(self):
        """Connect to PostgreSQL database."""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("✅ Connected to database for validation")
        except Exception as e:
            logger.warning(f"⚠️  Database connection failed: {e}")
            logger.info("   Running in offline mode with limited validation")
            
    def _load_known_cards(self):
        """Load known cards into memory for fast matching."""
        if not self.conn:
            return
            
        try:
            # Load all card names and metadata
            self.cursor.execute("""
                SELECT id, name, hp, set_name, card_number,
                       name_normalized, is_ex, is_gx, is_vmax
                FROM known_pokemon_cards
            """)
            
            for row in self.cursor.fetchall():
                self.known_cards[row['id']] = {
                    'name': row['name'],
                    'hp': row['hp'],
                    'set_name': row['set_name'],
                    'card_number': row['card_number'],
                    'name_normalized': row['name_normalized'],
                    'is_special': row['is_ex'] or row['is_gx'] or row['is_vmax']
                }
                
            logger.info(f"✅ Loaded {len(self.known_cards)} known cards")
            
        except Exception as e:
            logger.error(f"Failed to load known cards: {e}")
            
    def validate(self, vlm_output: Dict[str, Any]) -> ValidationResult:
        """
        Validate VLM output against known cards database.
        
        Args:
            vlm_output: Output from VLM with 'card_name', 'text', etc.
            
        Returns:
            ValidationResult with confidence adjustments
        """
        start_time = time.time()
        self.stats['total_validations'] += 1
        
        # Extract card information from VLM output
        card_name = vlm_output.get('card_name', '')
        full_text = vlm_output.get('text', '')
        
        if not card_name and not full_text:
            return ValidationResult(
                matched=False,
                confidence=vlm_output.get('confidence', 0.5),
                match_type='none',
                card_id=None,
                card_name=None,
                adjustments={},
                processing_time_ms=(time.time() - start_time) * 1000
            )
            
        # Check cache first
        cache_key = self._get_cache_key(card_name, full_text)
        if cache_key in self.cache:
            self.stats['cache_hits'] += 1
            cached_result = self.cache[cache_key]
            cached_result.processing_time_ms = (time.time() - start_time) * 1000
            return cached_result
            
        # Try exact match
        result = self._exact_match(card_name)
        
        # Try fuzzy match if exact fails
        if not result.matched:
            result = self._fuzzy_match(card_name)
            
        # Try similarity match if fuzzy fails
        if not result.matched:
            result = self._similarity_match(card_name, full_text)
            
        # Apply confidence adjustments
        result = self._apply_confidence_adjustments(result, vlm_output)
        
        # Update statistics
        if result.matched:
            if result.match_type == 'exact':
                self.stats['exact_matches'] += 1
            elif result.match_type == 'fuzzy':
                self.stats['fuzzy_matches'] += 1
        else:
            self.stats['no_matches'] += 1
            
        # Update cache
        self._update_cache(cache_key, result)
        
        # Record in database
        self._record_validation(vlm_output, result)
        
        result.processing_time_ms = (time.time() - start_time) * 1000
        return result
        
    def _exact_match(self, card_name: str) -> ValidationResult:
        """Try exact name match."""
        for card_id, card_data in self.known_cards.items():
            if card_data['name'].lower() == card_name.lower():
                return ValidationResult(
                    matched=True,
                    confidence=0.95,
                    match_type='exact',
                    card_id=card_id,
                    card_name=card_data['name'],
                    adjustments={'exact_match_boost': 0.15},
                    processing_time_ms=0
                )
                
        return ValidationResult(
            matched=False, confidence=0, match_type='none',
            card_id=None, card_name=None, adjustments={},
            processing_time_ms=0
        )
        
    def _fuzzy_match(self, card_name: str) -> ValidationResult:
        """Try fuzzy name matching."""
        best_match = None
        best_score = 0
        
        card_name_normalized = self._normalize_name(card_name)
        
        for card_id, card_data in self.known_cards.items():
            # Compare normalized names
            score = SequenceMatcher(
                None, 
                card_name_normalized,
                card_data['name_normalized']
            ).ratio()
            
            if score > best_score and score >= self.fuzzy_threshold:
                best_score = score
                best_match = (card_id, card_data)
                
        if best_match:
            return ValidationResult(
                matched=True,
                confidence=0.85 + (best_score - 0.85) * 0.5,  # 0.85-0.925
                match_type='fuzzy',
                card_id=best_match[0],
                card_name=best_match[1]['name'],
                adjustments={
                    'fuzzy_match_score': best_score,
                    'fuzzy_match_boost': 0.10
                },
                processing_time_ms=0
            )
            
        return ValidationResult(
            matched=False, confidence=0, match_type='none',
            card_id=None, card_name=None, adjustments={},
            processing_time_ms=0
        )
        
    def _similarity_match(self, card_name: str, full_text: str) -> ValidationResult:
        """Try similarity matching using multiple features."""
        # Extract features from text
        features = self._extract_features(full_text)
        
        best_match = None
        best_score = 0
        
        for card_id, card_data in self.known_cards.items():
            score = 0
            matches = 0
            
            # Name similarity
            name_score = SequenceMatcher(
                None,
                card_name.lower(),
                card_data['name'].lower()
            ).ratio()
            score += name_score * 0.5
            
            # HP match
            if features.get('hp') and card_data['hp']:
                if abs(features['hp'] - card_data['hp']) <= 10:
                    score += 0.2
                    matches += 1
                    
            # Set name match
            if features.get('set') and card_data['set_name']:
                if features['set'].lower() in card_data['set_name'].lower():
                    score += 0.2
                    matches += 1
                    
            # Card number match
            if features.get('number') and card_data['card_number']:
                if features['number'] == card_data['card_number']:
                    score += 0.1
                    matches += 1
                    
            if score > best_score and matches >= 2:
                best_score = score
                best_match = (card_id, card_data)
                
        if best_match and best_score >= 0.7:
            return ValidationResult(
                matched=True,
                confidence=0.70 + best_score * 0.15,  # 0.70-0.85
                match_type='similarity',
                card_id=best_match[0],
                card_name=best_match[1]['name'],
                adjustments={
                    'similarity_score': best_score,
                    'similarity_boost': 0.05
                },
                processing_time_ms=0
            )
            
        return ValidationResult(
            matched=False, confidence=0, match_type='none',
            card_id=None, card_name=None, adjustments={},
            processing_time_ms=0
        )
        
    def _extract_features(self, text: str) -> Dict[str, Any]:
        """Extract features from text for matching."""
        features = {}
        
        # Extract HP
        hp_match = re.search(r'HP[:\s]*(\d+)', text, re.IGNORECASE)
        if hp_match:
            features['hp'] = int(hp_match.group(1))
            
        # Extract card number
        num_match = re.search(r'(\d+)/(\d+)', text)
        if num_match:
            features['number'] = num_match.group(1)
            features['total'] = num_match.group(2)
            
        # Extract set name
        set_patterns = [
            r'from the set ([A-Za-z\s]+)',
            r'Set: ([A-Za-z\s]+)',
            r'from ([A-Za-z\s]+) set'
        ]
        for pattern in set_patterns:
            set_match = re.search(pattern, text, re.IGNORECASE)
            if set_match:
                features['set'] = set_match.group(1).strip()
                break
                
        return features
        
    def _normalize_name(self, name: str) -> str:
        """Normalize card name for matching."""
        # Remove special characters and normalize spaces
        normalized = re.sub(r'[^a-zA-Z0-9\s]', '', name.lower())
        normalized = re.sub(r'\s+', ' ', normalized).strip()
        return normalized
        
    def _apply_confidence_adjustments(self, 
                                     result: ValidationResult,
                                     vlm_output: Dict) -> ValidationResult:
        """Apply confidence adjustments based on match quality."""
        if not result.matched:
            # No match - slightly reduce confidence
            result.confidence = vlm_output.get('confidence', 0.5) * 0.9
            return result
            
        # Base VLM confidence
        base_confidence = vlm_output.get('confidence', 0.5)
        
        # Apply match-type boost
        if result.match_type == 'exact':
            adjusted = min(0.99, base_confidence + 0.15)
        elif result.match_type == 'fuzzy':
            adjusted = min(0.95, base_confidence + 0.10)
        else:  # similarity
            adjusted = min(0.90, base_confidence + 0.05)
            
        # Special card boost
        if result.card_id and self.known_cards[result.card_id]['is_special']:
            adjusted = min(0.99, adjusted + 0.02)
            
        result.confidence = adjusted
        result.adjustments['final_confidence'] = adjusted
        result.adjustments['confidence_delta'] = adjusted - base_confidence
        
        return result
        
    def _get_cache_key(self, card_name: str, full_text: str) -> str:
        """Generate cache key."""
        content = f"{card_name}|{full_text[:100]}"
        return hashlib.md5(content.encode()).hexdigest()
        
    def _update_cache(self, key: str, result: ValidationResult):
        """Update in-memory cache."""
        # Simple LRU: Remove oldest if cache full
        if len(self.cache) >= self.cache_size:
            oldest = next(iter(self.cache))
            del self.cache[oldest]
            
        self.cache[key] = result
        
    def _record_validation(self, vlm_output: Dict, result: ValidationResult):
        """Record validation in database for metrics."""
        if not self.conn:
            return
            
        try:
            self.cursor.execute("""
                INSERT INTO validation_cache 
                (input_hash, matched_card_id, confidence, match_type, processing_time_ms)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (input_hash) DO UPDATE
                SET hit_count = validation_cache.hit_count + 1,
                    last_accessed = CURRENT_TIMESTAMP
            """, (
                self._get_cache_key(
                    vlm_output.get('card_name', ''),
                    vlm_output.get('text', '')
                ),
                result.card_id,
                result.confidence,
                result.match_type,
                int(result.processing_time_ms)
            ))
            self.conn.commit()
        except Exception as e:
            logger.warning(f"Failed to record validation: {e}")
            self.conn.rollback()
            
    def get_statistics(self) -> Dict[str, Any]:
        """Get validation statistics."""
        total = self.stats['total_validations']
        if total == 0:
            return self.stats
            
        return {
            **self.stats,
            'match_rate': (self.stats['exact_matches'] + 
                          self.stats['fuzzy_matches']) / total,
            'cache_hit_rate': self.stats['cache_hits'] / total,
            'exact_match_rate': self.stats['exact_matches'] / total,
            'fuzzy_match_rate': self.stats['fuzzy_matches'] / total
        }
        
    def batch_validate(self, vlm_outputs: List[Dict]) -> List[ValidationResult]:
        """Validate multiple outputs efficiently."""
        results = []
        
        for output in vlm_outputs:
            result = self.validate(output)
            results.append(result)
            
        return results
        
    def close(self):
        """Close database connection."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
            
# Example usage and testing
if __name__ == "__main__":
    # Initialize service
    validator = DatasetValidationService()
    
    # Test cases
    test_cases = [
        {
            'card_name': 'Pikachu',
            'text': 'Pikachu HP 60 from Base Set 58/102',
            'confidence': 0.75
        },
        {
            'card_name': 'Charizard VMAX',
            'text': 'Charizard VMAX HP 330 from Champions Path',
            'confidence': 0.80
        },
        {
            'card_name': 'Pikachuu',  # Typo
            'text': 'Electric type Pokemon with 60 HP',
            'confidence': 0.65
        },
        {
            'card_name': 'Unknown Card',
            'text': 'Some random text',
            'confidence': 0.40
        }
    ]
    
    print("Testing Dataset Validation Service")
    print("="*60)
    
    for test in test_cases:
        result = validator.validate(test)
        print(f"\nInput: {test['card_name']}")
        print(f"  Matched: {result.matched}")
        print(f"  Type: {result.match_type}")
        print(f"  Confidence: {test['confidence']:.2f} → {result.confidence:.2f}")
        if result.matched:
            print(f"  Found: {result.card_name} [{result.card_id}]")
        print(f"  Time: {result.processing_time_ms:.1f}ms")
        
    # Print statistics
    stats = validator.get_statistics()
    print("\n" + "="*60)
    print("Validation Statistics:")
    for key, value in stats.items():
        if isinstance(value, float):
            print(f"  {key}: {value:.2%}")
        else:
            print(f"  {key}: {value}")
            
    validator.close()