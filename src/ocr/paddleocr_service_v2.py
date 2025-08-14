#!/usr/bin/env python3
"""
PaddleOCR Service v2 for CardMint
High-accuracy OCR implementation for PaddleOCR 3.x with photo metadata support
Targets 98%+ accuracy for card text extraction
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from datetime import datetime
import numpy as np
from PIL import Image
import cv2
from paddleocr import PaddleOCR
import logging

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

class CardOCRServiceV2:
    """High-accuracy OCR service for trading card text extraction with metadata"""
    
    def __init__(self):
        """Initialize PaddleOCR with high-accuracy models"""
        # PaddleOCR 3.x with PP-OCRv5 server models for best accuracy
        self.ocr = PaddleOCR(lang='en')
        logger.info("PaddleOCR v3 initialized with PP-OCRv5 models")
        
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
    
    def extract_photo_metadata(self, image_path: str) -> Dict:
        """
        Extract photo metadata including file info and image properties
        
        Args:
            image_path: Path to the image file
            
        Returns:
            Dictionary containing photo metadata
        """
        metadata = {}
        
        try:
            # File metadata
            stat = os.stat(image_path)
            metadata['file_path'] = str(image_path)
            metadata['file_size_bytes'] = stat.st_size
            metadata['file_modified_time'] = datetime.fromtimestamp(stat.st_mtime).isoformat()
            metadata['capture_timestamp'] = datetime.now().isoformat()
            
            # Image properties
            img = cv2.imread(image_path)
            if img is not None:
                metadata['image_height'] = img.shape[0]
                metadata['image_width'] = img.shape[1]
                metadata['image_channels'] = img.shape[2] if len(img.shape) > 2 else 1
                
                # Calculate image quality metrics
                gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) > 2 else img
                metadata['brightness_mean'] = float(np.mean(gray))
                metadata['brightness_std'] = float(np.std(gray))
                
                # Sharpness estimation using Laplacian variance
                laplacian = cv2.Laplacian(gray, cv2.CV_64F)
                metadata['sharpness_score'] = float(laplacian.var())
                
            # Camera settings (would be populated from EXIF if available)
            # For now, these will be filled from the Sony camera capture
            metadata['camera_model'] = 'Sony ZV-E10M2'  # Known from our setup
            metadata['capture_mode'] = 'USB'
            metadata['capture_settings'] = {
                'resolution': f"{metadata.get('image_width', 0)}x{metadata.get('image_height', 0)}",
                'format': 'JPEG'
            }
            
        except Exception as e:
            logger.error(f"Failed to extract metadata: {e}")
            metadata['metadata_error'] = str(e)
            
        return metadata
    
    def extract_card_regions_v2(self, ocr_result) -> Dict:
        """
        Extract and categorize card text regions from PaddleOCR 3.x result
        
        Args:
            ocr_result: OCRResult object from PaddleOCR 3.x
            
        Returns:
            Structured card data with confidence scores
        """
        if not ocr_result:
            return {
                'success': False,
                'error': 'No OCR result',
                'regions': []
            }
        
        # Extract texts, scores, and bounding boxes from new API
        try:
            rec_texts = ocr_result.get('rec_texts', [])
            rec_scores = ocr_result.get('rec_scores', [])
            dt_polys = ocr_result.get('dt_polys', [])
            
            if not rec_texts:
                return {
                    'success': False,
                    'error': 'No text detected',
                    'regions': []
                }
            
            regions = []
            full_text_parts = []
            total_confidence = 0
            count = 0
            
            for i, (text, score) in enumerate(zip(rec_texts, rec_scores)):
                if i < len(dt_polys):
                    bbox = dt_polys[i]
                    
                    # Calculate region position for categorization
                    y_coords = [point[1] for point in bbox]
                    x_coords = [point[0] for point in bbox]
                    y_center = sum(y_coords) / len(y_coords)
                    x_center = sum(x_coords) / len(x_coords)
                    
                    # Categorize by position
                    region_type = 'body'
                    if y_center < 100:  # Top region - likely card name
                        region_type = 'title'
                    elif y_center > 400:  # Bottom region - likely stats/metadata
                        region_type = 'metadata'
                    
                    regions.append({
                        'text': text,
                        'confidence': float(score),
                        'bounding_box': {
                            'points': bbox,
                            'center': {'x': x_center, 'y': y_center}
                        },
                        'type': region_type
                    })
                    
                    full_text_parts.append(text)
                    total_confidence += score
                    count += 1
            
            # Sort regions by vertical position for reading order
            regions.sort(key=lambda r: r['bounding_box']['center']['y'])
            
            avg_confidence = total_confidence / count if count > 0 else 0
            
            return {
                'success': True,
                'full_text': ' '.join(full_text_parts),
                'regions': regions,
                'avg_confidence': float(avg_confidence),
                'total_regions': count,
                'requires_review': avg_confidence < 0.85  # Flag for manual review if <85%
            }
            
        except Exception as e:
            logger.error(f"Failed to extract regions: {e}")
            return {
                'success': False,
                'error': str(e),
                'regions': []
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
        all_passes = []
        
        for pass_num in range(passes):
            try:
                # Different preprocessing for each pass
                if pass_num == 0:
                    # First pass: standard preprocessing
                    img = self.preprocess_image(image_path)
                else:
                    # Second pass: original image with minimal preprocessing
                    img = cv2.imread(image_path)
                
                # Run OCR (suppress deprecation warning)
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    result = self.ocr.ocr(img)
                
                # Extract the OCRResult object
                if result and len(result) > 0:
                    ocr_res = result[0]
                    extracted = self.extract_card_regions_v2(ocr_res)
                    
                    all_passes.append({
                        'pass': pass_num + 1,
                        'confidence': extracted.get('avg_confidence', 0),
                        'regions_found': extracted.get('total_regions', 0)
                    })
                    
                    if extracted['success'] and extracted.get('avg_confidence', 0) > best_confidence:
                        best_confidence = extracted['avg_confidence']
                        best_result = extracted
                        best_result['pass_number'] = pass_num + 1
                        best_result['all_passes'] = all_passes
                    
            except Exception as e:
                logger.error(f"Pass {pass_num + 1} failed: {str(e)}")
                continue
        
        if best_result:
            best_result['pass_summary'] = all_passes
        
        return best_result or {'success': False, 'error': 'All passes failed', 'pass_summary': all_passes}
    
    def process_card(self, image_path: str, high_accuracy: bool = True) -> Dict:
        """
        Main entry point for card OCR processing with metadata
        
        Args:
            image_path: Path to card image
            high_accuracy: Whether to use multiple passes for higher accuracy
            
        Returns:
            OCR results with confidence scores, extracted text, and photo metadata
        """
        try:
            # Extract photo metadata first
            metadata = self.extract_photo_metadata(image_path)
            
            # Run OCR processing
            if high_accuracy:
                result = self.process_multiple_passes(image_path, passes=2)
            else:
                # Single pass for speed
                img = self.preprocess_image(image_path)
                
                # Run OCR
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    ocr_result = self.ocr.ocr(img)
                
                if ocr_result and len(ocr_result) > 0:
                    result = self.extract_card_regions_v2(ocr_result[0])
                else:
                    result = {'success': False, 'error': 'No OCR result'}
            
            # Add metadata to result
            result['photo_metadata'] = metadata
            result['image_path'] = image_path
            result['high_accuracy_mode'] = high_accuracy
            result['processing_timestamp'] = datetime.now().isoformat()
            
            # Extract likely card information
            if result.get('success') and result.get('regions'):
                result['extracted_card_info'] = self.extract_card_metadata(result['regions'])
            
            # Calculate accuracy metrics
            if result.get('avg_confidence'):
                result['meets_98_target'] = result['avg_confidence'] >= 0.98
                result['confidence_gap'] = max(0, 0.98 - result['avg_confidence'])
            
            return result
            
        except Exception as e:
            return {
                'success': False,
                'error': str(e),
                'image_path': image_path,
                'photo_metadata': self.extract_photo_metadata(image_path)
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
            'text_sections': [],
            'confidence_by_field': {}
        }
        
        # First region with high confidence is likely the card name
        title_regions = [r for r in regions if r['type'] == 'title' and r['confidence'] > 0.8]
        if title_regions:
            metadata['card_name'] = title_regions[0]['text']
            metadata['confidence_by_field']['card_name'] = title_regions[0]['confidence']
        
        # Look for patterns in text
        for region in regions:
            text = region['text'].strip()
            conf = region['confidence']
            
            # Card number pattern (e.g., "001/350", "#123")
            if any(c.isdigit() for c in text) and ('/' in text or '#' in text):
                metadata['card_number'] = text
                metadata['confidence_by_field']['card_number'] = conf
            
            # Rarity indicators
            rarity_keywords = ['Common', 'Uncommon', 'Rare', 'Super Rare', 'Ultra Rare', 
                             'Mythic', 'Legendary', 'Holo', 'Foil', 'Secret Rare']
            for rarity in rarity_keywords:
                if rarity.lower() in text.lower():
                    metadata['rarity'] = rarity
                    metadata['confidence_by_field']['rarity'] = conf
                    break
            
            # Collect all text sections with high confidence
            if conf > 0.7:
                metadata['text_sections'].append({
                    'text': text,
                    'confidence': conf,
                    'type': region['type']
                })
        
        # Calculate overall field confidence
        if metadata['confidence_by_field']:
            metadata['avg_field_confidence'] = sum(metadata['confidence_by_field'].values()) / len(metadata['confidence_by_field'])
        else:
            metadata['avg_field_confidence'] = 0.0
            
        return metadata

def main():
    """CLI interface for testing OCR service"""
    if len(sys.argv) < 2:
        print(json.dumps({
            'success': False,
            'error': 'Usage: python paddleocr_service_v2.py <image_path> [high_accuracy]'
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
    service = CardOCRServiceV2()
    result = service.process_card(image_path, high_accuracy)
    
    # Output JSON result
    print(json.dumps(result, indent=2, ensure_ascii=False, default=str))

if __name__ == '__main__':
    main()