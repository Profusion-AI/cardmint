#!/usr/bin/env python3
"""
Improved PaddleOCR Service for CardMint with better card name detection
"""

import json
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np
from PIL import Image
import cv2
from paddleocr import PaddleOCR
import logging
import re

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class ImprovedCardOCRService:
    """OCR service with improved Pokemon card name detection"""
    
    # Common Pokemon name database for validation
    POKEMON_NAMES = [
        'Blissey', 'Chansey', 'Pikachu', 'Charizard', 'Bulbasaur', 'Squirtle',
        'Mewtwo', 'Mew', 'Gengar', 'Alakazam', 'Machamp', 'Dragonite',
        'Snorlax', 'Lapras', 'Eevee', 'Vaporeon', 'Jolteon', 'Flareon',
        'Zapdos', 'Moltres', 'Articuno', 'Gyarados', 'Magikarp', 'Psyduck',
        'Golduck', 'Meowth', 'Persian', 'Growlithe', 'Arcanine', 'Poliwag',
        'Polteageist', 'Dragapult', 'Toxtricity', 'Grimmsnarl', 'Corviknight'
    ]
    
    # Common card keywords to filter out
    CARD_KEYWORDS = [
        'basic', 'stage', 'hp', 'ex', 'gx', 'v', 'vmax', 'vstar', 
        'evolves', 'from', 'retreat', 'weakness', 'resistance',
        'attack', 'ability', 'pokemon', 'trainer', 'energy'
    ]
    
    def __init__(self):
        """Initialize with optimized PaddleOCR settings"""
        # Use simpler initialization for better compatibility
        # det_model_dir and rec_model_dir can be specified for custom models
        self.ocr = PaddleOCR(lang='en')
        logger.info("Improved OCR Service initialized")
        
    def preprocess_for_text_detection(self, image_path: str) -> np.ndarray:
        """Preprocess image specifically for better text detection"""
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Failed to read image: {image_path}")
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply threshold to get binary image
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Denoise
        denoised = cv2.medianBlur(binary, 3)
        
        # Convert back to 3-channel for PaddleOCR
        result = cv2.cvtColor(denoised, cv2.COLOR_GRAY2BGR)
        
        return result
    
    def extract_text_regions(self, image_path: str) -> List[Dict]:
        """Extract text regions with improved detection"""
        regions = []
        
        try:
            # Read original image for OCR
            img = cv2.imread(image_path)
            
            # Run OCR with original image first
            result = self.ocr.ocr(image_path)
            
            if result and result[0]:
                for item in result[0]:
                    if len(item) >= 2:
                        bbox = item[0]
                        text_data = item[1]
                        
                        if isinstance(text_data, (list, tuple)) and len(text_data) >= 2:
                            text = text_data[0]
                            confidence = text_data[1]
                            
                            # Calculate position
                            y_positions = [point[1] for point in bbox]
                            x_positions = [point[0] for point in bbox]
                            y_center = sum(y_positions) / len(y_positions)
                            x_center = sum(x_positions) / len(x_positions)
                            
                            # Improved region classification based on position
                            # Pokemon cards typically have name at top 15% of card
                            img_height = img.shape[0]
                            relative_y = y_center / img_height
                            
                            if relative_y < 0.15:  # Top 15% of card
                                region_type = 'title'
                            elif relative_y > 0.85:  # Bottom 15%
                                region_type = 'metadata'
                            else:
                                region_type = 'body'
                            
                            regions.append({
                                'text': text.strip(),
                                'confidence': float(confidence),
                                'bbox': bbox,
                                'type': region_type,
                                'y_center': y_center,
                                'x_center': x_center,
                                'relative_y': relative_y
                            })
            
            # If we didn't find enough text, try with preprocessed image
            if len(regions) < 5:
                preprocessed = self.preprocess_for_text_detection(image_path)
                result2 = self.ocr.ocr(preprocessed)
                
                if result2 and result2[0]:
                    for item in result2[0]:
                        if len(item) >= 2:
                            bbox = item[0]
                            text_data = item[1]
                            
                            if isinstance(text_data, (list, tuple)) and len(text_data) >= 2:
                                text = text_data[0].strip()
                                confidence = text_data[1]
                                
                                # Check if this text is already found
                                if not any(r['text'] == text for r in regions):
                                    y_positions = [point[1] for point in bbox]
                                    x_positions = [point[0] for point in bbox]
                                    y_center = sum(y_positions) / len(y_positions)
                                    x_center = sum(x_positions) / len(x_positions)
                                    
                                    relative_y = y_center / img.shape[0]
                                    
                                    if relative_y < 0.15:
                                        region_type = 'title'
                                    elif relative_y > 0.85:
                                        region_type = 'metadata'
                                    else:
                                        region_type = 'body'
                                    
                                    regions.append({
                                        'text': text,
                                        'confidence': float(confidence) * 0.9,  # Lower confidence for preprocessed
                                        'bbox': bbox,
                                        'type': region_type,
                                        'y_center': y_center,
                                        'x_center': x_center,
                                        'relative_y': relative_y
                                    })
                        
        except Exception as e:
            logger.error(f"Error extracting text regions: {e}")
            
        # Sort by y position
        regions.sort(key=lambda r: r['y_center'])
        
        return regions
    
    def find_pokemon_name(self, regions: List[Dict]) -> Tuple[Optional[str], float]:
        """Find the Pokemon card name using improved heuristics"""
        
        # Look for title regions first
        title_regions = [r for r in regions if r['type'] == 'title']
        
        # Also check top body regions if no title found
        if not title_regions:
            title_regions = [r for r in regions if r['relative_y'] < 0.2]
        
        best_name = None
        best_score = 0
        
        for region in title_regions:
            text = region['text'].strip()
            confidence = region['confidence']
            
            # Skip if it's a known keyword
            text_lower = text.lower()
            if any(keyword in text_lower for keyword in self.CARD_KEYWORDS):
                continue
            
            # Skip if it's just numbers or HP indicator
            if text.replace(' ', '').replace('HP', '').isdigit():
                continue
            
            # Check against known Pokemon names (fuzzy match)
            for pokemon in self.POKEMON_NAMES:
                if pokemon.lower() in text_lower or text_lower in pokemon.lower():
                    score = confidence * 1.5  # Boost score for known Pokemon
                    if score > best_score:
                        best_name = pokemon
                        best_score = score
                    break
            else:
                # Not a known Pokemon, but could still be the name
                # Heuristics: card names are usually 1-3 words, start with capital
                words = text.split()
                if 1 <= len(words) <= 3 and text[0].isupper():
                    # Check if it looks like a name (not a sentence)
                    if not any(w.lower() in ['the', 'a', 'an', 'with', 'from'] for w in words):
                        score = confidence * 0.8  # Lower score for unknown names
                        if score > best_score:
                            best_name = text
                            best_score = score
        
        return best_name, best_score
    
    def extract_card_info(self, regions: List[Dict]) -> Dict:
        """Extract structured card information"""
        info = {
            'card_name': None,
            'hp': None,
            'stage': None,
            'card_number': None,
            'attacks': [],
            'weakness': None,
            'retreat_cost': None,
            'rarity': None
        }
        
        # Find Pokemon name
        name, name_confidence = self.find_pokemon_name(regions)
        info['card_name'] = name
        info['name_confidence'] = name_confidence
        
        # Extract other information
        for region in regions:
            text = region['text'].strip()
            text_lower = text.lower()
            
            # HP extraction
            hp_match = re.search(r'hp\s*(\d+)', text_lower)
            if hp_match:
                info['hp'] = int(hp_match.group(1))
            
            # Stage extraction
            stage_patterns = ['basic', 'stage 1', 'stage 2']
            for stage in stage_patterns:
                if stage in text_lower:
                    info['stage'] = stage.title()
                    break
            
            # Card number
            number_match = re.search(r'(\d+)/(\d+)', text)
            if number_match:
                info['card_number'] = text
            
            # Weakness
            if 'weakness' in text_lower:
                info['weakness'] = text
            
            # Retreat cost
            if 'retreat' in text_lower:
                info['retreat_cost'] = text
            
            # Attacks (simple heuristic: capitalized words in body that aren't keywords)
            if region['type'] == 'body' and len(text) > 3 and text[0].isupper():
                if not any(kw in text_lower for kw in self.CARD_KEYWORDS):
                    # Could be an attack name
                    if re.match(r'^[A-Z][a-z]+(\s+[A-Z]?[a-z]+){0,2}$', text):
                        info['attacks'].append(text)
        
        return info
    
    def process_card(self, image_path: str) -> Dict:
        """Main entry point for processing a Pokemon card"""
        try:
            # Extract text regions
            regions = self.extract_text_regions(image_path)
            
            if not regions:
                return {
                    'success': False,
                    'error': 'No text detected',
                    'regions': []
                }
            
            # Calculate average confidence
            avg_confidence = sum(r['confidence'] for r in regions) / len(regions)
            
            # Extract card information
            card_info = self.extract_card_info(regions)
            
            # Format regions for output
            formatted_regions = []
            for r in regions:
                formatted_regions.append({
                    'text': r['text'],
                    'confidence': r['confidence'],
                    'type': r['type'],
                    'bounding_box': {
                        'top_left': r['bbox'][0],
                        'top_right': r['bbox'][1],
                        'bottom_right': r['bbox'][2],
                        'bottom_left': r['bbox'][3]
                    },
                    'center': {'x': r['x_center'], 'y': r['y_center']}
                })
            
            return {
                'success': True,
                'full_text': ' '.join([r['text'] for r in regions]),
                'regions': formatted_regions,
                'avg_confidence': avg_confidence,
                'total_regions': len(regions),
                'requires_review': avg_confidence < 0.85 or card_info['card_name'] is None,
                'extracted_card_info': card_info
            }
            
        except Exception as e:
            logger.error(f"Error processing card: {e}")
            return {
                'success': False,
                'error': str(e)
            }

def main():
    """CLI interface for testing"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'Usage: python paddleocr_service_improved.py <image_path>'
        }))
        sys.exit(1)
    
    image_path = sys.argv[1]
    
    if not Path(image_path).exists():
        print(json.dumps({
            'success': False,
            'error': f'Image not found: {image_path}'
        }))
        sys.exit(1)
    
    service = ImprovedCardOCRService()
    result = service.process_card(image_path)
    
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()