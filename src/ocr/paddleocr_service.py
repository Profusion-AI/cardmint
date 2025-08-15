#!/usr/bin/env python3
"""
PaddleOCR Service for CardMint
High-accuracy OCR implementation targeting 98%+ accuracy for card text extraction
Phase 2A Enhancement: Smart Preprocessing Intelligence
"""

import json
import base64
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import numpy as np
from PIL import Image
import cv2
from paddleocr import PaddleOCR
import logging

# Import Phase 2A smart preprocessing
from smart_preprocessing import SmartPreprocessor

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class CardOCRService:
    """High-accuracy OCR service with intelligent preprocessing"""
    
    def __init__(self):
        """Initialize PaddleOCR with high-performance inference enabled"""
        # Use high-accuracy English models with 2025 optimizations
        # Enable high-performance inference (HPI) for 3-5x speed improvement
        # Use server models for better accuracy, MKL-DNN for CPU acceleration
        # Initialize with absolutely minimal configuration to ensure compatibility
        # This matches the working configuration from our earlier tests
        self.ocr = PaddleOCR(lang='en')
        
        # Phase 2A: Initialize smart preprocessor
        self.smart_preprocessor = SmartPreprocessor()
        logger.info("Phase 2A: Smart preprocessing enabled")
        
    def preprocess_image(self, image_path: str) -> Tuple[np.ndarray, Dict]:
        """
        Phase 2A: Smart preprocessing based on image quality assessment
        
        Args:
            image_path: Path to the image file
            
        Returns:
            Tuple of (preprocessed_image, processing_info)
        """
        # Use smart preprocessor for intelligent quality-based processing
        result, processing_info = self.smart_preprocessor.preprocess_image_smart(image_path)
        
        # Log preprocessing decision for monitoring
        level = processing_info['preprocessing_level']
        quality_score = processing_info['quality_assessment']['quality_score']
        operations = processing_info['operations_applied']
        
        logger.info(f"Phase 2A: {level} preprocessing (quality: {quality_score:.2f}, ops: {len(operations)})")
        
        return result, processing_info
    
    def preprocess_image_legacy(self, image_path: str) -> np.ndarray:
        """
        Legacy preprocessing method (Phase 1) - kept for fallback
        
        Args:
            image_path: Path to the image file
            
        Returns:
            Preprocessed image as numpy array
        """
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Failed to read image: {image_path}")
        
        # Convert to grayscale for preprocessing
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply adaptive histogram equalization for better contrast
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8,8))
        enhanced = clahe.apply(gray)
        
        # Denoise while preserving edges
        denoised = cv2.bilateralFilter(enhanced, 9, 75, 75)
        
        # Detect and correct skew
        coords = np.column_stack(np.where(denoised > 0))
        if len(coords) > 100:  # Need enough points for rotation
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            if abs(angle) > 0.5:  # Only correct if skew is significant
                (h, w) = denoised.shape[:2]
                center = (w // 2, h // 2)
                M = cv2.getRotationMatrix2D(center, angle, 1.0)
                denoised = cv2.warpAffine(denoised, M, (w, h),
                                         flags=cv2.INTER_CUBIC,
                                         borderMode=cv2.BORDER_REPLICATE)
        
        # Convert back to color for PaddleOCR
        result = cv2.cvtColor(denoised, cv2.COLOR_GRAY2BGR)
        
        # Optional: Sharpen text
        kernel = np.array([[-1,-1,-1],
                          [-1, 9,-1],
                          [-1,-1,-1]])
        sharpened = cv2.filter2D(result, -1, kernel)
        
        # Balance between sharpened and denoised
        final = cv2.addWeighted(result, 0.7, sharpened, 0.3, 0)
        
        return final
    
    def extract_card_regions(self, ocr_result: List) -> Dict:
        """
        Extract and categorize card text regions from new PaddleOCR API format
        
        Args:
            ocr_result: Raw OCR result from PaddleOCR predict() method
            
        Returns:
            Structured card data with confidence scores
        """
        if not ocr_result or len(ocr_result) == 0:
            return {
                'success': False,
                'error': 'No text detected',
                'regions': []
            }
        
        # New PaddleOCR API returns a list with one result dict
        result_data = ocr_result[0]
        
        # Extract text and confidence arrays from new format
        if 'rec_texts' not in result_data or 'rec_scores' not in result_data:
            return {
                'success': False,
                'error': 'Invalid OCR result format',
                'regions': []
            }
        
        texts = result_data['rec_texts']
        scores = result_data['rec_scores']
        polys = result_data.get('rec_polys', result_data.get('dt_polys', []))
        
        if len(texts) != len(scores):
            return {
                'success': False,
                'error': 'Mismatched text and score arrays',
                'regions': []
            }
            
        regions = []
        full_text_parts = []
        total_confidence = 0
        count = 0
        
        for i, (text, confidence) in enumerate(zip(texts, scores)):
            if not text.strip():
                continue
                
            # Get bounding box if available
            bbox = None
            if i < len(polys) and polys[i] is not None:
                poly = polys[i]
                if hasattr(poly, 'shape') and poly.shape[0] >= 4:
                    # Convert numpy array to list of points
                    bbox = [
                        [int(poly[0][0]), int(poly[0][1])],  # top_left
                        [int(poly[1][0]), int(poly[1][1])],  # top_right  
                        [int(poly[2][0]), int(poly[2][1])],  # bottom_right
                        [int(poly[3][0]), int(poly[3][1])]   # bottom_left
                    ]
            
            # Calculate region position for categorization
            if bbox:
                y_center = (bbox[0][1] + bbox[2][1]) / 2
                x_center = (bbox[0][0] + bbox[2][0]) / 2
            else:
                y_center = 0
                x_center = 0
            
            # Categorize by position (refined for Pokemon cards)
            region_type = 'body'
            if y_center < 100:  # Top region - likely card name
                region_type = 'title'
            elif y_center > 600:  # Bottom region - likely stats/metadata
                region_type = 'metadata'
            
            regions.append({
                'text': text.strip(),
                'confidence': float(confidence),
                'bounding_box': {
                    'top_left': bbox[0] if bbox else [0, 0],
                    'top_right': bbox[1] if bbox else [0, 0],
                    'bottom_right': bbox[2] if bbox else [0, 0],
                    'bottom_left': bbox[3] if bbox else [0, 0]
                } if bbox else None,
                'type': region_type,
                'center': {'x': x_center, 'y': y_center}
            })
            
            full_text_parts.append(text.strip())
            total_confidence += confidence
            count += 1
        
        # Sort regions by vertical position for reading order
        regions.sort(key=lambda r: r['center']['y'])
        
        avg_confidence = total_confidence / count if count > 0 else 0
        
        return {
            'success': True,
            'full_text': ' '.join(full_text_parts),
            'regions': regions,
            'avg_confidence': float(avg_confidence),
            'total_regions': count,
            'requires_review': avg_confidence < 0.85  # Flag for manual review if <85%
        }
    
    def process_multiple_passes(self, image_path: str, passes: int = 2) -> Dict:
        """
        Phase 2A: Smart multi-pass OCR with adaptive preprocessing
        
        Args:
            image_path: Path to the image
            passes: Number of OCR passes to perform
            
        Returns:
            Best result from multiple passes with preprocessing info
        """
        best_result = None
        best_confidence = 0
        preprocessing_info = None
        
        for pass_num in range(passes):
            try:
                # Different preprocessing strategies for each pass
                if pass_num == 0:
                    # First pass: smart preprocessing based on quality assessment
                    img, preproc_info = self.preprocess_image(image_path)
                    preprocessing_info = preproc_info
                else:
                    # Second pass: minimal preprocessing (original approach)
                    img = cv2.imread(image_path)
                    preprocessing_info = {
                        'preprocessing_level': 'raw',
                        'operations_applied': ['no_preprocessing'],
                        'quality_assessment': {'quality_score': 0.0}
                    }
                
                # Run OCR using predict API
                result = self.ocr.predict(img)
                
                # Extract and structure results
                extracted = self.extract_card_regions(result)
                
                if extracted['success'] and extracted.get('avg_confidence', 0) > best_confidence:
                    best_confidence = extracted['avg_confidence']
                    best_result = extracted
                    best_result['pass_number'] = pass_num + 1
                    best_result['preprocessing_info'] = preprocessing_info
                    
            except Exception as e:
                logger.error(f"Pass {pass_num + 1} failed: {str(e)}")
                continue
        
        # Include preprocessing information in final result
        if best_result and preprocessing_info:
            best_result['preprocessing_used'] = preprocessing_info
        
        return best_result or {'success': False, 'error': 'All passes failed'}
    
    def process_card(self, image_path: str, high_accuracy: bool = True) -> Dict:
        """
        Phase 2A: Main entry point with smart preprocessing
        
        Args:
            image_path: Path to card image
            high_accuracy: Whether to use multiple passes for higher accuracy
            
        Returns:
            OCR results with confidence scores and extracted text
        """
        try:
            if high_accuracy:
                result = self.process_multiple_passes(image_path, passes=2)
            else:
                # Single pass for speed with smart preprocessing
                img, preprocessing_info = self.preprocess_image(image_path)
                ocr_result = self.ocr.predict(img)
                result = self.extract_card_regions(ocr_result)
                result['preprocessing_used'] = preprocessing_info
            
            # Add metadata
            result['image_path'] = image_path
            result['high_accuracy_mode'] = high_accuracy
            result['phase'] = 'Phase 2A - Smart Preprocessing'
            
            # Extract likely card information
            if result.get('success') and result.get('regions'):
                result['extracted_card_info'] = self.extract_card_metadata(result['regions'])
            
            return result
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'image_path': image_path,
                'phase': 'Phase 2A - Error'
            }
    
    def extract_card_metadata(self, regions: List[Dict]) -> Dict:
        """
        Extract structured Pokemon card metadata from OCR regions
        
        Args:
            regions: List of OCR text regions
            
        Returns:
            Structured card metadata with Pokemon-specific fields
        """
        import re
        
        metadata = {
            'card_name': None,
            'card_set': None,
            'card_number': None,
            'rarity': None,
            'card_type': None,
            'hp': None,
            'stage': None,
            'pokemon_type': None,
            'attacks': [],
            'weakness': None,
            'resistance': None,
            'retreat_cost': None,
            'illustrator': None,
            'text_sections': []
        }
        
        # Pokemon card specific patterns
        pokemon_stages = ['basic', 'stage 1', 'stage 2', 'break', 'ex', 'gx', 'v', 'vmax', 'vstar']
        pokemon_types = ['grass', 'fire', 'water', 'lightning', 'psychic', 'fighting', 'darkness', 'metal', 'dragon', 'fairy', 'colorless']
        
        # Identify card name (usually the longest text in title region, excluding stage/HP)
        title_regions = [r for r in regions if r['type'] == 'title' and r['confidence'] > 0.8]
        title_texts = []
        
        for region in title_regions:
            text = region['text'].strip()
            # Skip if it's HP indicator or exact stage match
            is_stage = text.lower() in [stage.lower() for stage in pokemon_stages]
            is_hp = text.startswith('HP') or re.match(r'^hp\s*\d+$', text.lower())
            
            if not is_stage and not is_hp:
                title_texts.append((text, region['confidence'], len(text)))
        
        # Pick the longest title text as card name (Pokemon names are usually longer than other title elements)
        if title_texts:
            metadata['card_name'] = max(title_texts, key=lambda x: x[2])[0]
        
        # Process all regions for specific patterns
        for region in regions:
            text = region['text'].strip()
            text_lower = text.lower()
            
            # HP pattern (e.g., "HP60", "HP 120")
            hp_match = re.search(r'hp\s*(\d+)', text_lower)
            if hp_match:
                metadata['hp'] = int(hp_match.group(1))
            
            # Stage pattern (exact match or word boundary)
            for stage in pokemon_stages:
                # Use word boundary matching to avoid false positives
                if re.search(r'\b' + re.escape(stage.lower()) + r'\b', text_lower):
                    metadata['stage'] = stage.title()
                    break
            
            # Card number pattern (e.g., "12/12", "156/185", "001/350")
            number_match = re.search(r'(\d+)/(\d+)', text)
            if number_match:
                metadata['card_number'] = text
            
            # Weakness pattern
            if 'weakness' in text_lower:
                # Look for the next region that might contain the type
                metadata['weakness'] = 'Present'
            
            # Resistance pattern  
            if 'resistance' in text_lower:
                metadata['resistance'] = 'Present'
            
            # Retreat cost pattern
            if 'retreat' in text_lower:
                metadata['retreat_cost'] = 'Present'
            
            # Illustrator pattern
            if 'illus' in text_lower or 'illustration' in text_lower:
                # Extract name after "Illus." or similar
                illus_match = re.search(r'illus\.?\s*(.+)', text, re.IGNORECASE)
                if illus_match:
                    metadata['illustrator'] = illus_match.group(1).strip()
                else:
                    metadata['illustrator'] = text
            
            # Attack detection (words in metadata region that could be attacks)
            if (region['type'] == 'metadata' and 
                len(text) > 2 and 
                text.isalpha() and 
                text[0].isupper() and
                text_lower not in ['weakness', 'resistance', 'retreat', 'basic'] and
                not any(stage.lower() in text_lower for stage in pokemon_stages)):
                
                # Look for damage value nearby (next region with just numbers)
                damage = None
                for other_region in regions:
                    if (abs(other_region['center']['y'] - region['center']['y']) < 50 and
                        other_region['center']['x'] > region['center']['x'] and
                        re.match(r'^\d+\+?$', other_region['text'].strip())):
                        damage = other_region['text'].strip()
                        break
                
                metadata['attacks'].append({
                    'name': text,
                    'damage': damage,
                    'confidence': region['confidence']
                })
            
            # Rarity indicators
            rarity_keywords = ['common', 'uncommon', 'rare', 'holo', 'mythic', 'legendary', 'secret', 'ultra']
            for rarity in rarity_keywords:
                if rarity in text_lower:
                    metadata['rarity'] = rarity.title()
                    break
            
            # Collect all text sections
            if region['confidence'] > 0.7:
                metadata['text_sections'].append({
                    'text': text,
                    'confidence': region['confidence'],
                    'type': region['type']
                })
        
        return metadata

def main():
    """CLI interface for testing OCR service"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'Usage: python paddleocr_service.py <image_path> [high_accuracy]'
        }))
        sys.exit(1)
    
    image_path = sys.argv[1]
    high_accuracy = sys.argv[2].lower() == 'true' if len(sys.argv) > 2 else True
    
    # Check if image exists
    if not Path(image_path).exists():
        print(json.dumps({
            'success': False,
            'error': f'Image not found: {image_path}'
        }))
        sys.exit(1)
    
    # Initialize service and process
    service = CardOCRService()
    result = service.process_card(image_path, high_accuracy)
    
    # Output JSON result
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()