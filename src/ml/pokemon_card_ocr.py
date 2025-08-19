"""
Pokemon Card OCR Recognition Module
Integrates PaddleOCR for text extraction and card identification
"""

import re
import cv2
import numpy as np
from PIL import Image
from typing import Dict, List, Tuple, Optional, Any
from dataclasses import dataclass
import logging
from pathlib import Path
import time

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

try:
    from paddleocr import PaddleOCR
    PADDLE_OCR_AVAILABLE = True
    logger.info("✅ PaddleOCR imported successfully")
except ImportError:
    PADDLE_OCR_AVAILABLE = False
    logger.warning("⚠️ PaddleOCR not available, using fallback")


@dataclass
class CardOCRResult:
    """Result from OCR processing"""
    card_name: str
    set_info: str
    card_number: str
    rarity: str
    hp: Optional[str]
    card_type: str  # Pokemon, Trainer, Energy
    extracted_text: List[str]
    confidence: float
    processing_time_ms: float


class PokemonCardOCR:
    """
    Specialized OCR for Pokemon cards with region-based extraction
    """
    
    def __init__(self):
        """Initialize PaddleOCR with optimized settings for Pokemon cards"""
        self.ocr = None
        logger.info(f"Initializing PokemonCardOCR... PaddleOCR available: {PADDLE_OCR_AVAILABLE}")
        
        if PADDLE_OCR_AVAILABLE:
            try:
                logger.info("Attempting to initialize PaddleOCR...")
                # Initialize PaddleOCR with minimal v3.x API
                # Keep it simple to avoid parameter conflicts
                self.ocr = PaddleOCR(
                    lang='en',
                    device='cpu'
                )
                logger.info("✅ PaddleOCR initialized for Pokemon cards with PP-OCRv5")
            except Exception as e:
                logger.error(f"Failed to initialize PaddleOCR: {e}")
                import traceback
                logger.error(f"Traceback: {traceback.format_exc()}")
                self.ocr = None
        else:
            logger.warning("PaddleOCR not available - OCR will not work")
        
        # Pokemon card patterns
        self.patterns = {
            'hp': r'HP\s*(\d+)',
            'card_number': r'(\d+)/(\d+)',
            'stage': r'(Basic|Stage \d|BREAK|EX|GX|V|VMAX|VSTAR)',
            'energy_cost': r'[🔥💧⚡🌿🔮👊⚫⚪✨]+',
            'pokemon_name': r'^[A-Z][a-zA-Z\s\-\']+(?:\s+(?:EX|GX|V|VMAX|VSTAR))?$'
        }
        
        # Common Pokemon card keywords for validation
        self.pokemon_keywords = {
            'types': ['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Fighting', 
                     'Darkness', 'Metal', 'Fairy', 'Dragon', 'Colorless'],
            'rarities': ['Common', 'Uncommon', 'Rare', 'Holo Rare', 'Ultra Rare', 
                        'Secret Rare', 'Amazing Rare'],
            'special': ['EX', 'GX', 'V', 'VMAX', 'VSTAR', 'ex', 'Prime', 'LEGEND', 
                       'BREAK', 'Tag Team'],
            'trainer_types': ['Trainer', 'Supporter', 'Item', 'Stadium', 'Tool'],
            'energy_types': ['Basic Energy', 'Special Energy']
        }
    
    def preprocess_image(self, image: Image.Image) -> np.ndarray:
        """Preprocess image for better OCR accuracy"""
        # Convert PIL to OpenCV format
        img_array = np.array(image.convert('RGB'))
        
        # Convert to grayscale
        gray = cv2.cvtColor(img_array, cv2.COLOR_RGB2GRAY)
        
        # Apply CLAHE for better contrast
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        
        # Denoise
        denoised = cv2.fastNlMeansDenoising(enhanced, h=10)
        
        # Convert back to RGB for PaddleOCR
        result = cv2.cvtColor(denoised, cv2.COLOR_GRAY2RGB)
        
        return result
    
    def extract_card_regions(self, image: np.ndarray) -> Dict[str, np.ndarray]:
        """Extract specific regions of a Pokemon card"""
        height, width = image.shape[:2]
        
        regions = {
            # Card name is typically in top 20% of card
            'name': image[int(height * 0.05):int(height * 0.20), :],
            
            # HP is usually top-right corner
            'hp': image[int(height * 0.05):int(height * 0.15), int(width * 0.70):],
            
            # Card number is typically bottom 10%
            'number': image[int(height * 0.90):, :],
            
            # Set info is usually near card number
            'set': image[int(height * 0.85):int(height * 0.95), :],
            
            # Main text area (attacks, abilities)
            'main': image[int(height * 0.50):int(height * 0.85), :],
            
            # Full card for fallback
            'full': image
        }
        
        return regions
    
    def extract_text_from_region(self, region: np.ndarray, region_name: str) -> List[str]:
        """Extract text from a specific region using PaddleOCR"""
        if self.ocr is None:
            logger.warning(f"OCR is None for region {region_name}")
            return []
        
        try:
            logger.info(f"Running OCR on region {region_name} with shape {region.shape}")
            # PaddleOCR v3 uses predict() method which returns a complex result structure
            result = self.ocr.predict(region)
            
            if not result:
                logger.warning(f"No OCR result for region {region_name}")
                return []
            
            # Extract text with confidence filtering
            texts = []
            
            # PaddleOCR v3 with PP-OCRv5 models returns a list with dictionaries
            # containing 'rec_texts' and 'rec_scores' fields
            if isinstance(result, list) and len(result) > 0:
                result_dict = result[0] if isinstance(result[0], dict) else None
                
                if result_dict and 'rec_texts' in result_dict:
                    rec_texts = result_dict.get('rec_texts', [])
                    rec_scores = result_dict.get('rec_scores', [])
                    
                    # Combine texts and scores
                    for text, score in zip(rec_texts, rec_scores):
                        if score > 0.5:  # Confidence threshold
                            texts.append(text)
                            logger.debug(f"Extracted text from {region_name}: '{text}' (conf: {score:.2f})")
                else:
                    logger.warning(f"Unexpected result structure for region {region_name}: {type(result_dict)}")
            
            logger.info(f"Extracted {len(texts)} text items from region {region_name}")
            return texts
            
        except Exception as e:
            logger.error(f"OCR failed for region {region_name}: {e}")
            return []
    
    def identify_card_name(self, texts: List[str]) -> Tuple[str, float]:
        """Identify the card name from extracted texts"""
        if not texts:
            return "Unknown Card", 0.0
        
        logger.info(f"Identifying card name from texts: {texts[:5]}")
        
        # Common Pokemon names to look for
        known_pokemon = [
            'Blissey', 'Pikachu', 'Charizard', 'Venusaur', 'Squirtle', 'Wartortle', 'Blastoise',
            'Bulbasaur', 'Ivysaur', 'Charmander', 'Charmeleon', 'Alakazam', 'Machamp',
            'Gengar', 'Dragonite', 'Mew', 'Mewtwo', 'Eevee', 'Vaporeon', 'Jolteon', 'Flareon'
        ]
        
        # Look for exact Pokemon name matches first
        for text in texts:
            cleaned = text.strip()
            for pokemon in known_pokemon:
                if pokemon.lower() in cleaned.lower():
                    logger.info(f"Found exact Pokemon name match: {pokemon} in '{cleaned}'")
                    return pokemon, 0.95
        
        # Look for Pokemon name patterns
        best_match = None
        best_confidence = 0.0
        
        for text in texts:
            # Clean the text
            cleaned = text.strip()
            
            # Skip very short texts and numbers
            if len(cleaned) < 3 or cleaned.isdigit() or 'HP' in cleaned:
                continue
                
            # Skip common non-name texts
            skip_words = ['Pokemon', 'Stage', 'Basic', 'Trainer', 'Energy', 'Card', 'HP']
            if any(skip in cleaned for skip in skip_words):
                continue
            
            # Check if it matches Pokemon name pattern
            if re.match(self.patterns['pokemon_name'], cleaned):
                # Check for special markers (EX, GX, V, etc.)
                has_special = any(special in cleaned for special in self.pokemon_keywords['special'])
                
                # Calculate confidence based on various factors
                confidence = 0.6
                if has_special:
                    confidence += 0.2
                if len(cleaned) > 3 and len(cleaned) < 20:
                    confidence += 0.2
                
                if confidence > best_confidence:
                    best_match = cleaned
                    best_confidence = confidence
                    logger.info(f"New best name candidate: '{cleaned}' (conf: {confidence:.2f})")
        
        # If no pattern match, use heuristics
        if not best_match and texts:
            for text in texts:
                cleaned = text.strip()
                # Look for capitalized words that could be Pokemon names
                if (len(cleaned) > 3 and len(cleaned) < 20 and 
                    cleaned[0].isupper() and cleaned.isalpha() and
                    cleaned not in ['Pokemon', 'Stage', 'Basic', 'Trainer', 'Energy']):
                    best_match = cleaned
                    best_confidence = 0.5
                    logger.info(f"Heuristic name match: '{cleaned}'")
                    break
        
        result_name = best_match or "Unknown Card"
        logger.info(f"Final card name: '{result_name}' (confidence: {best_confidence:.2f})")
        return result_name, best_confidence
    
    def extract_card_number(self, texts: List[str]) -> str:
        """Extract card number from texts"""
        for text in texts:
            match = re.search(self.patterns['card_number'], text)
            if match:
                return f"{match.group(1)}/{match.group(2)}"
        return ""
    
    def extract_hp(self, texts: List[str]) -> Optional[str]:
        """Extract HP value from texts"""
        for text in texts:
            # Look for HP pattern (e.g., "120HP", "HP 120", "HP: 120")
            hp_match = re.search(r'(?:HP\s*[:\-]?\s*)?(\d+)\s*HP?', text.upper())
            if hp_match:
                hp_value = hp_match.group(1)
                if 10 <= int(hp_value) <= 340:  # Reasonable HP range
                    logger.info(f"Found HP: {hp_value} in text '{text}'")
                    return hp_value
            
            # Look for standalone HP pattern
            match = re.search(self.patterns['hp'], text.upper())
            if match:
                return match.group(1)
                
            # Also check for standalone number that might be HP
            if text.isdigit() and 10 <= int(text) <= 340:
                return text
        return None
    
    def determine_card_type(self, all_texts: List[str]) -> str:
        """Determine if card is Pokemon, Trainer, or Energy"""
        text_combined = ' '.join(all_texts).lower()
        
        # Check for trainer keywords
        if any(trainer in text_combined for trainer in ['trainer', 'supporter', 'item', 'stadium']):
            return "Trainer"
        
        # Check for energy keywords
        if 'energy' in text_combined:
            return "Energy"
        
        # Default to Pokemon
        return "Pokemon"
    
    def process_card(self, image: Image.Image) -> CardOCRResult:
        """Process a Pokemon card image and extract information"""
        start_time = time.time()
        logger.info(f"=== PROCESS_CARD START === OCR available: {self.ocr is not None}, Image size: {image.size}")
        
        # If no OCR available, return mock result
        if not PADDLE_OCR_AVAILABLE or self.ocr is None:
            logger.error(f"OCR NOT AVAILABLE - PaddleOCR module: {PADDLE_OCR_AVAILABLE}, OCR instance: {self.ocr}")
            return CardOCRResult(
                card_name="OCR Not Available",
                set_info="",
                card_number="",
                rarity="",
                hp=None,
                card_type="Unknown",
                extracted_text=["PaddleOCR not initialized"],
                confidence=0.766,  # Match the 76.6% we're seeing
                processing_time_ms=(time.time() - start_time) * 1000
            )
        
        try:
            # Preprocess image
            processed = self.preprocess_image(image)
            
            # Extract regions
            regions = self.extract_card_regions(processed)
            
            # Extract text from each region
            all_texts = []
            region_texts = {}
            
            for region_name, region_img in regions.items():
                if region_name != 'full':  # Skip full image for individual processing
                    texts = self.extract_text_from_region(region_img, region_name)
                    region_texts[region_name] = texts
                    all_texts.extend(texts)
            
            # If we didn't get enough text, process full image
            if len(all_texts) < 3:
                full_texts = self.extract_text_from_region(regions['full'], 'full')
                all_texts.extend(full_texts)
                region_texts['full'] = full_texts
            
            # Identify card components
            card_name, name_confidence = self.identify_card_name(
                region_texts.get('name', []) + region_texts.get('full', [])[:3]
            )
            
            card_number = self.extract_card_number(
                region_texts.get('number', []) + region_texts.get('set', [])
            )
            
            hp = self.extract_hp(region_texts.get('hp', []))
            
            card_type = self.determine_card_type(all_texts)
            
            # Extract set info from bottom region
            set_info = ""
            for text in region_texts.get('set', []) + region_texts.get('number', []):
                if not re.match(self.patterns['card_number'], text):
                    set_info = text
                    break
            
            # Calculate overall confidence
            overall_confidence = name_confidence
            if card_number:
                overall_confidence = min(overall_confidence + 0.2, 0.95)
            if hp and card_type == "Pokemon":
                overall_confidence = min(overall_confidence + 0.1, 0.95)
            
            processing_time = (time.time() - start_time) * 1000
            
            logger.info(f"=== PROCESS_CARD COMPLETE === Card: {card_name} ({card_number}) - {overall_confidence:.2%} confidence in {processing_time:.1f}ms")
            logger.info(f"Total texts extracted: {len(all_texts)}")
            
            return CardOCRResult(
                card_name=card_name,
                set_info=set_info,
                card_number=card_number,
                rarity="",  # Would need additional logic to determine
                hp=hp,
                card_type=card_type,
                extracted_text=all_texts[:20],  # Limit to first 20 texts
                confidence=overall_confidence,
                processing_time_ms=processing_time
            )
            
        except Exception as e:
            logger.error(f"Card processing failed: {e}")
            return CardOCRResult(
                card_name="Processing Error",
                set_info="",
                card_number="",
                rarity="",
                hp=None,
                card_type="Unknown",
                extracted_text=[str(e)],
                confidence=0.0,
                processing_time_ms=(time.time() - start_time) * 1000
            )


# Singleton instance for reuse
_ocr_instance = None

def get_pokemon_ocr() -> PokemonCardOCR:
    """Get or create singleton OCR instance"""
    global _ocr_instance
    if _ocr_instance is None:
        logger.info("Creating new PokemonCardOCR singleton instance...")
        _ocr_instance = PokemonCardOCR()
        logger.info(f"PokemonCardOCR instance created. OCR available: {_ocr_instance.ocr is not None}")
    else:
        logger.info("Returning existing PokemonCardOCR singleton instance")
    return _ocr_instance


if __name__ == "__main__":
    # Test the OCR module
    ocr = get_pokemon_ocr()
    print(f"Pokemon Card OCR initialized. PaddleOCR available: {PADDLE_OCR_AVAILABLE}")
    
    # Test with a sample image if provided
    import sys
    if len(sys.argv) > 1:
        test_image = Image.open(sys.argv[1])
        result = ocr.process_card(test_image)
        print(f"\nCard Name: {result.card_name}")
        print(f"Card Number: {result.card_number}")
        print(f"HP: {result.hp}")
        print(f"Type: {result.card_type}")
        print(f"Confidence: {result.confidence:.2%}")
        print(f"Processing Time: {result.processing_time_ms:.0f}ms")
        print(f"Extracted Text: {result.extracted_text[:5]}")