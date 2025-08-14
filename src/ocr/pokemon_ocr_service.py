#!/usr/bin/env python3
"""
Pokemon Card OCR Service for CardMint
Specialized OCR implementation for Pokemon card field extraction
Targets 98%+ accuracy for card identification
"""

import json
import os
import sys
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
from datetime import datetime
import numpy as np
from PIL import Image
import cv2
from paddleocr import PaddleOCR
import logging

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class PokemonCardOCR:
    """Specialized OCR service for Pokemon trading cards"""
    
    # Pokemon-specific patterns
    PATTERNS = {
        'card_number': r'#?\d+(?:/\d+)?',  # #4 or 123/350
        'set_code': r'[A-Z]{2,4}\d{0,3}',  # SV01, BASE, etc.
        'hp': r'HP\s*(\d+)',
        'stage': r'(?:Basic|Stage\s+[12]|BREAK|EX|GX|V|VMAX|VSTAR)',
        '1st_edition': r'(?:1st\s+Edition|Edition\s+1)',
        'shadowless': r'(?:Shadowless)',
        'retreat_cost': r'Retreat\s*Cost',
        'weakness': r'Weakness',
        'resistance': r'Resistance',
        'pokedex_number': r'#(\d{3})',
        'rarity_text': r'(?:Common|Uncommon|Rare|Holo\s*Rare|Secret\s*Rare|Ultra\s*Rare)',
        'energy_cost': r'[🔥⚡💧🌿👊🔮⚙️🌑🧚🐉○]+',
        'regulation_mark': r'\b[A-H]\b(?:\s*Regulation)?',
        'illustrator': r'(?:Illus\.|Illustrated by)\s*([\w\s]+)',
        'copyright': r'©\s*\d{4}',
        'promo': r'(?:PROMO|Promo|Black\s*Star)',
        'full_art': r'(?:Full\s*Art|FA)',
        'rainbow': r'(?:Rainbow|Secret)',
        'gold': r'(?:Gold|Golden)',
        'variant': r'(?:Reverse\s*Holo|Holo|Foil)'
    }
    
    # Set code mappings
    SET_CODES = {
        # Base Set Era
        'BASE': 'Pokemon Base Set',
        'JU': 'Jungle',
        'FO': 'Fossil',
        'TR': 'Team Rocket',
        'BS2': 'Base Set 2',
        'GYM': 'Gym Heroes',
        'GC': 'Gym Challenge',
        
        # Neo Era
        'N1': 'Neo Genesis',
        'N2': 'Neo Discovery',
        'N3': 'Neo Revelation',
        'N4': 'Neo Destiny',
        
        # E-Card Era
        'AQ': 'Aquapolis',
        'SK': 'Skyridge',
        'EX': 'Expedition',
        
        # Modern Era
        'SV': 'Scarlet & Violet',
        'SS': 'Sword & Shield',
        'SM': 'Sun & Moon',
        'XY': 'XY',
        'BW': 'Black & White',
        
        # Special Sets
        'PR': 'Promo',
        'CEL': 'Celebrations',
        'CRZ': 'Crown Zenith'
    }
    
    def __init__(self):
        """Initialize Pokemon-specific OCR with high-accuracy models"""
        self.ocr = PaddleOCR(lang='en')
        logger.info("Pokemon OCR initialized with PP-OCRv5 models")
        
    def extract_card_regions(self, image_path: str) -> Dict[str, Any]:
        """
        Extract card regions based on Pokemon card layout
        
        Args:
            image_path: Path to card image
            
        Returns:
            Dictionary of card regions with text and positions
        """
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Failed to read image: {image_path}")
            
        height, width = img.shape[:2]
        
        # Define regions based on typical Pokemon card layout
        regions = {
            'header': {
                'area': (0, 0, width, int(height * 0.15)),  # Top 15% - name, HP, type
                'expected': ['card_name', 'hp', 'stage', 'pokemon_type']
            },
            'artwork': {
                'area': (0, int(height * 0.15), width, int(height * 0.55)),  # Middle 40% - artwork
                'expected': ['pokedex_entry', 'abilities']
            },
            'attacks': {
                'area': (0, int(height * 0.55), width, int(height * 0.75)),  # Attack section
                'expected': ['attack_names', 'damage', 'energy_cost']
            },
            'footer': {
                'area': (0, int(height * 0.75), width, height),  # Bottom 25% - set info
                'expected': ['set_number', 'rarity', 'illustrator', 'weakness', 'resistance']
            }
        }
        
        extracted_regions = {}
        
        for region_name, region_info in regions.items():
            x1, y1, x2, y2 = region_info['area']
            region_img = img[y1:y2, x1:x2]
            
            # Run OCR on region
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                result = self.ocr.ocr(region_img)
            
            if result and len(result) > 0:
                extracted_regions[region_name] = {
                    'text': self.extract_text_from_result(result[0]),
                    'expected_fields': region_info['expected'],
                    'bbox': region_info['area']
                }
                
        return extracted_regions
    
    def extract_text_from_result(self, ocr_result) -> List[Dict]:
        """Extract text and confidence from OCR result"""
        text_items = []
        
        if not ocr_result:
            return text_items
            
        for item in ocr_result:
            if isinstance(item, (list, tuple)) and len(item) >= 2:
                bbox = item[0]
                text_data = item[1]
                
                if isinstance(text_data, (list, tuple)) and len(text_data) >= 2:
                    text = text_data[0]
                    conf = text_data[1]
                else:
                    text = str(text_data)
                    conf = 0.5
                    
                text_items.append({
                    'text': text,
                    'confidence': float(conf),
                    'bbox': bbox
                })
                
        return text_items
    
    def extract_pokemon_fields(self, regions: Dict) -> Dict:
        """
        Extract specific Pokemon card fields from OCR regions
        
        Args:
            regions: Dictionary of OCR regions
            
        Returns:
            Structured Pokemon card data
        """
        card_data = {
            'card_name': None,
            'hp': None,
            'pokemon_type': None,
            'stage': None,
            'set_name': None,
            'set_code': None,
            'set_number': None,
            'set_total': None,
            'rarity': None,
            'attacks': [],
            'abilities': [],
            'weakness': None,
            'resistance': None,
            'retreat_cost': None,
            'illustrator': None,
            'regulation_mark': None,
            'is_first_edition': False,
            'is_promo': False,
            'is_holo': False,
            'variant_type': None,
            'pokedex_entry': None,
            'confidence_scores': {}
        }
        
        # Process header region for name, HP, stage
        if 'header' in regions:
            header_text = regions['header']['text']
            card_data.update(self.extract_header_info(header_text))
        
        # Process footer region for set info
        if 'footer' in regions:
            footer_text = regions['footer']['text']
            card_data.update(self.extract_footer_info(footer_text))
        
        # Process attacks region
        if 'attacks' in regions:
            attacks_text = regions['attacks']['text']
            card_data['attacks'] = self.extract_attacks(attacks_text)
        
        # Check for special editions
        full_text = self.combine_all_text(regions)
        card_data.update(self.detect_special_editions(full_text))
        
        return card_data
    
    def extract_header_info(self, text_items: List[Dict]) -> Dict:
        """Extract card name, HP, stage, and type from header"""
        info = {
            'confidence_scores': {}
        }
        
        if not text_items:
            return info
        
        # Usually the first high-confidence text is the card name
        for item in text_items:
            if item['confidence'] > 0.8 and not info.get('card_name'):
                # Skip if it looks like HP or stage
                if not re.match(r'HP\s*\d+|Stage\s+\d+|Basic', item['text'], re.I):
                    info['card_name'] = item['text']
                    info['confidence_scores']['card_name'] = item['confidence']
            
            # Extract HP
            hp_match = re.search(self.PATTERNS['hp'], item['text'], re.I)
            if hp_match:
                info['hp'] = int(hp_match.group(1))
                info['confidence_scores']['hp'] = item['confidence']
            
            # Extract stage
            stage_match = re.search(self.PATTERNS['stage'], item['text'], re.I)
            if stage_match:
                info['stage'] = stage_match.group(0)
                info['confidence_scores']['stage'] = item['confidence']
        
        return info
    
    def extract_footer_info(self, text_items: List[Dict]) -> Dict:
        """Extract set information, rarity, and metadata from footer"""
        info = {
            'confidence_scores': {}
        }
        
        combined_text = ' '.join([item['text'] for item in text_items])
        
        # Extract set number (e.g., "123/350")
        number_match = re.search(r'(\d+)\s*/\s*(\d+)', combined_text)
        if number_match:
            info['set_number'] = int(number_match.group(1))
            info['set_total'] = int(number_match.group(2))
            
            # Find confidence for this match
            for item in text_items:
                if number_match.group(0) in item['text']:
                    info['confidence_scores']['set_number'] = item['confidence']
                    break
        
        # Extract set code
        for code, name in self.SET_CODES.items():
            if code in combined_text.upper():
                info['set_code'] = code
                info['set_name'] = name
                break
        
        # Extract rarity
        rarity_match = re.search(self.PATTERNS['rarity_text'], combined_text, re.I)
        if rarity_match:
            info['rarity'] = rarity_match.group(0)
        
        # Extract illustrator
        illus_match = re.search(self.PATTERNS['illustrator'], combined_text, re.I)
        if illus_match:
            info['illustrator'] = illus_match.group(1).strip()
        
        # Extract regulation mark
        reg_match = re.search(self.PATTERNS['regulation_mark'], combined_text)
        if reg_match:
            info['regulation_mark'] = reg_match.group(0)[0]  # Just the letter
        
        # Extract weakness and resistance
        if 'Weakness' in combined_text:
            info['weakness'] = self.extract_type_after_keyword(combined_text, 'Weakness')
        
        if 'Resistance' in combined_text:
            info['resistance'] = self.extract_type_after_keyword(combined_text, 'Resistance')
        
        return info
    
    def extract_attacks(self, text_items: List[Dict]) -> List[Dict]:
        """Extract attack information"""
        attacks = []
        
        current_attack = None
        
        for item in text_items:
            text = item['text']
            
            # Check if this looks like an attack name (usually starts with capital letter)
            if re.match(r'^[A-Z][a-z]+', text) and not re.match(r'^\d+$', text):
                if current_attack:
                    attacks.append(current_attack)
                
                current_attack = {
                    'name': text,
                    'damage': None,
                    'energy_cost': [],
                    'effect': None,
                    'confidence': item['confidence']
                }
            
            # Check for damage (usually a number at the end)
            elif current_attack and re.match(r'^\d+\+?$', text):
                current_attack['damage'] = text
            
            # Check for energy symbols or cost
            elif current_attack and any(c in '🔥⚡💧🌿👊🔮⚙️🌑🧚🐉○' for c in text):
                current_attack['energy_cost'].append(text)
        
        if current_attack:
            attacks.append(current_attack)
        
        return attacks
    
    def detect_special_editions(self, full_text: str) -> Dict:
        """Detect special edition markers"""
        info = {}
        
        # Check for 1st Edition
        if re.search(self.PATTERNS['1st_edition'], full_text, re.I):
            info['is_first_edition'] = True
        
        # Check for Promo
        if re.search(self.PATTERNS['promo'], full_text, re.I):
            info['is_promo'] = True
        
        # Check for holo variants
        if re.search(r'(?:Holo|Reverse\s*Holo)', full_text, re.I):
            info['is_holo'] = True
            
            if 'Reverse' in full_text:
                info['variant_type'] = 'reverse_holo'
            else:
                info['variant_type'] = 'holo'
        
        # Check for special variants
        if re.search(self.PATTERNS['full_art'], full_text, re.I):
            info['variant_type'] = 'full_art'
        elif re.search(self.PATTERNS['rainbow'], full_text, re.I):
            info['variant_type'] = 'rainbow'
        elif re.search(self.PATTERNS['gold'], full_text, re.I):
            info['variant_type'] = 'gold'
        
        return info
    
    def extract_type_after_keyword(self, text: str, keyword: str) -> Optional[str]:
        """Extract Pokemon type after a keyword like Weakness or Resistance"""
        pattern = f"{keyword}\\s*([🔥⚡💧🌿👊🔮⚙️🌑🧚🐉]|Fire|Water|Grass|Lightning|Fighting|Psychic|Metal|Dark|Fairy|Dragon)"
        match = re.search(pattern, text, re.I)
        if match:
            return match.group(1)
        return None
    
    def combine_all_text(self, regions: Dict) -> str:
        """Combine all text from all regions"""
        all_text = []
        for region_data in regions.values():
            if 'text' in region_data:
                for item in region_data['text']:
                    all_text.append(item['text'])
        return ' '.join(all_text)
    
    def calculate_overall_confidence(self, card_data: Dict) -> float:
        """Calculate overall OCR confidence score"""
        if not card_data.get('confidence_scores'):
            return 0.0
        
        scores = card_data['confidence_scores'].values()
        if not scores:
            return 0.0
            
        return sum(scores) / len(scores)
    
    def process_pokemon_card(self, image_path: str) -> Dict:
        """
        Main entry point for Pokemon card processing
        
        Args:
            image_path: Path to card image
            
        Returns:
            Complete card data with all extracted fields
        """
        try:
            # Extract regions
            regions = self.extract_card_regions(image_path)
            
            # Extract Pokemon-specific fields
            card_data = self.extract_pokemon_fields(regions)
            
            # Add metadata
            card_data['image_path'] = image_path
            card_data['processing_timestamp'] = datetime.now().isoformat()
            card_data['overall_confidence'] = self.calculate_overall_confidence(card_data)
            card_data['needs_review'] = card_data['overall_confidence'] < 0.85
            
            # Build search query for PriceCharting
            search_parts = []
            if card_data['card_name']:
                search_parts.append(card_data['card_name'])
            if card_data['set_name']:
                search_parts.append(card_data['set_name'])
            if card_data['set_number']:
                search_parts.append(f"#{card_data['set_number']}")
            
            card_data['pricecharting_query'] = ' '.join(search_parts)
            
            return {
                'success': True,
                'card_data': card_data,
                'regions': regions
            }
            
        except Exception as e:
            logger.error(f"Failed to process Pokemon card: {e}")
            return {
                'success': False,
                'error': str(e),
                'image_path': image_path
            }

def main():
    """CLI interface for testing Pokemon OCR"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'Usage: python pokemon_ocr_service.py <image_path>'
        }))
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    # Check if image exists
    if not Path(image_path).exists():
        print(json.dumps({
            'success': False,
            'error': f'Image not found: {image_path}'
        }))
        sys.exit(1)
    
    # Initialize service and process
    service = PokemonCardOCR()
    result = service.process_pokemon_card(image_path)
    
    # Output JSON result
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

if __name__ == '__main__':
    main()