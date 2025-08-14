#!/usr/bin/env python3
"""
PaddleOCR Service for CardMint
High-accuracy OCR implementation targeting 98%+ accuracy for card text extraction
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

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class CardOCRService:
    """High-accuracy OCR service for trading card text extraction"""
    
    def __init__(self):
        """Initialize PaddleOCR with high-accuracy models"""
        # Use high-accuracy English models with minimal configuration
        # PaddleOCR 3.x will auto-download the best models
        # Note: New API doesn't accept show_log parameter
        self.ocr = PaddleOCR(lang='en')
        
    def preprocess_image(self, image_path: str) -> np.ndarray:
        """
        Preprocess image for optimal OCR accuracy
        
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
        Extract and categorize card text regions
        
        Args:
            ocr_result: Raw OCR result from PaddleOCR
            
        Returns:
            Structured card data with confidence scores
        """
        if not ocr_result or (isinstance(ocr_result, list) and len(ocr_result) == 0):
            return {
                'success': False,
                'error': 'No text detected',
                'regions': []
            }
        
        # Handle new API format - result might be wrapped differently
        if isinstance(ocr_result, list) and len(ocr_result) > 0:
            # Check if it's the old format [[bbox, (text, conf)], ...]
            # or new format with different structure
            if ocr_result[0] is None:
                return {
                    'success': False,
                    'error': 'No text detected in image',
                    'regions': []
                }
            ocr_data = ocr_result[0] if isinstance(ocr_result[0], list) else ocr_result
        else:
            ocr_data = ocr_result
            
        regions = []
        full_text_parts = []
        total_confidence = 0
        count = 0
        
        for line in ocr_data:
            if line is None:
                continue
            try:
                bbox = line[0]
                text = line[1][0] if isinstance(line[1], (list, tuple)) else line[1]
                confidence = line[1][1] if isinstance(line[1], (list, tuple)) and len(line[1]) > 1 else 0.5
            except (IndexError, TypeError) as e:
                logger.warning(f"Failed to parse OCR line: {e}")
                continue
            
            # Calculate region position for categorization
            try:
                y_center = (bbox[0][1] + bbox[2][1]) / 2
                x_center = (bbox[0][0] + bbox[2][0]) / 2
            except:
                y_center = 0
                x_center = 0
            
            # Categorize by position (can be refined based on card layout)
            region_type = 'body'
            if y_center < 100:  # Top region - likely card name
                region_type = 'title'
            elif y_center > 400:  # Bottom region - likely stats/metadata
                region_type = 'metadata'
            
            regions.append({
                'text': text,
                'confidence': float(confidence),
                'bounding_box': {
                    'top_left': bbox[0],
                    'top_right': bbox[1],
                    'bottom_right': bbox[2],
                    'bottom_left': bbox[3]
                },
                'type': region_type,
                'center': {'x': x_center, 'y': y_center}
            })
            
            full_text_parts.append(text)
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
        Perform multiple OCR passes with different preprocessing for higher accuracy
        
        Args:
            image_path: Path to the image
            passes: Number of OCR passes to perform
            
        Returns:
            Best result from multiple passes
        """
        best_result = None
        best_confidence = 0
        
        for pass_num in range(passes):
            try:
                # Different preprocessing for each pass
                if pass_num == 0:
                    # First pass: standard preprocessing
                    img = self.preprocess_image(image_path)
                else:
                    # Second pass: original image with minimal preprocessing
                    img = cv2.imread(image_path)
                
                # Run OCR using new predict API
                result = self.ocr.predict(img)
                
                # Extract and structure results
                extracted = self.extract_card_regions(result)
                
                if extracted['success'] and extracted.get('avg_confidence', 0) > best_confidence:
                    best_confidence = extracted['avg_confidence']
                    best_result = extracted
                    best_result['pass_number'] = pass_num + 1
                    
            except Exception as e:
                logger.error(f"Pass {pass_num + 1} failed: {str(e)}")
                continue
        
        return best_result or {'success': False, 'error': 'All passes failed'}
    
    def process_card(self, image_path: str, high_accuracy: bool = True) -> Dict:
        """
        Main entry point for card OCR processing
        
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
                # Single pass for speed
                img = self.preprocess_image(image_path)
                ocr_result = self.ocr.predict(img)
                result = self.extract_card_regions(ocr_result)
            
            # Add metadata
            result['image_path'] = image_path
            result['high_accuracy_mode'] = high_accuracy
            
            # Extract likely card information
            if result.get('success') and result.get('regions'):
                result['extracted_card_info'] = self.extract_card_metadata(result['regions'])
            
            return result
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'image_path': image_path
            }
    
    def extract_card_metadata(self, regions: List[Dict]) -> Dict:
        """
        Extract structured card metadata from OCR regions
        
        Args:
            regions: List of OCR text regions
            
        Returns:
            Structured card metadata
        """
        metadata = {
            'card_name': None,
            'card_set': None,
            'card_number': None,
            'rarity': None,
            'card_type': None,
            'text_sections': []
        }
        
        # First region with high confidence is likely the card name
        title_regions = [r for r in regions if r['type'] == 'title' and r['confidence'] > 0.8]
        if title_regions:
            metadata['card_name'] = title_regions[0]['text']
        
        # Look for patterns in text
        for region in regions:
            text = region['text'].strip()
            
            # Card number pattern (e.g., "001/350", "#123")
            if any(c.isdigit() for c in text) and ('/' in text or '#' in text):
                metadata['card_number'] = text
            
            # Rarity indicators
            rarity_keywords = ['Common', 'Uncommon', 'Rare', 'Mythic', 'Legendary', 'Holo']
            for rarity in rarity_keywords:
                if rarity.lower() in text.lower():
                    metadata['rarity'] = rarity
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