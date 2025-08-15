#!/usr/bin/env python3
"""
Phase 2A: Smart Preprocessing Intelligence for CardMint OCR
Intelligently skip heavy preprocessing for high-quality Pokemon card images
"""

import cv2
import numpy as np
from typing import Tuple, Dict
import logging

logger = logging.getLogger(__name__)

class ImageQualityAssessment:
    """Assess image quality to determine optimal preprocessing strategy"""
    
    @staticmethod
    def assess_image_quality(image_path: str) -> Dict:
        """
        Assess image quality metrics to determine preprocessing needs
        
        Args:
            image_path: Path to the image file
            
        Returns:
            Quality metrics and recommended preprocessing level
        """
        img = cv2.imread(image_path)
        if img is None:
            return {
                'quality_score': 0.0,
                'preprocessing_level': 'heavy',
                'reasons': ['failed_to_load'],
                'metrics': {}
            }
        
        # Convert to grayscale for analysis
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # 1. Blur Assessment (Laplacian variance)
        blur_score = cv2.Laplacian(gray, cv2.CV_64F).var()
        
        # 2. Brightness Assessment
        brightness = np.mean(gray)
        
        # 3. Contrast Assessment (standard deviation)
        contrast = np.std(gray)
        
        # 4. Noise Assessment (using median filtering difference)
        median_filtered = cv2.medianBlur(gray, 5)
        noise_level = np.mean(np.abs(gray.astype(float) - median_filtered.astype(float)))
        
        # 5. Saturation Assessment (for color quality)
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        saturation = np.mean(hsv[:, :, 1])
        
        # 6. Edge Density (Canny edge detection)
        edges = cv2.Canny(gray, 50, 150)
        edge_density = np.sum(edges > 0) / (gray.shape[0] * gray.shape[1])
        
        metrics = {
            'blur_score': float(blur_score),
            'brightness': float(brightness),
            'contrast': float(contrast),
            'noise_level': float(noise_level),
            'saturation': float(saturation),
            'edge_density': float(edge_density)
        }
        
        # Quality thresholds (based on empirical testing with Pokemon cards)
        quality_checks = {
            'sharp': blur_score > 500,           # Well-focused image
            'well_lit': 40 < brightness < 220,   # Good lighting
            'good_contrast': contrast > 30,      # Sufficient contrast
            'low_noise': noise_level < 10,       # Minimal noise
            'good_saturation': saturation > 20,  # Adequate color
            'rich_edges': edge_density > 0.02    # Good edge detail
        }
        
        # Determine quality score (percentage of checks passed)
        passed_checks = sum(quality_checks.values())
        quality_score = passed_checks / len(quality_checks)
        
        # Determine preprocessing level based on quality
        if quality_score >= 0.83:  # 5/6 checks passed
            preprocessing_level = 'minimal'
        elif quality_score >= 0.67:  # 4/6 checks passed
            preprocessing_level = 'standard'
        else:
            preprocessing_level = 'heavy'
        
        # Identify specific issues for logging
        failed_checks = [check for check, passed in quality_checks.items() if not passed]
        
        return {
            'quality_score': quality_score,
            'preprocessing_level': preprocessing_level,
            'reasons': failed_checks,
            'metrics': metrics,
            'quality_checks': quality_checks
        }

class SmartPreprocessor:
    """Intelligent preprocessing that adapts to image quality"""
    
    def __init__(self):
        self.quality_assessor = ImageQualityAssessment()
    
    def preprocess_image_smart(self, image_path: str, force_level: str = None) -> Tuple[np.ndarray, Dict]:
        """
        Apply intelligent preprocessing based on image quality assessment
        
        Args:
            image_path: Path to the image file
            force_level: Override quality assessment ('minimal', 'standard', 'heavy')
            
        Returns:
            Tuple of (preprocessed_image, processing_info)
        """
        # Assess image quality
        quality_info = self.quality_assessor.assess_image_quality(image_path)
        
        # Override level if specified
        preprocessing_level = force_level or quality_info['preprocessing_level']
        
        # Load image
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Failed to read image: {image_path}")
        
        processing_info = {
            'quality_assessment': quality_info,
            'preprocessing_level': preprocessing_level,
            'operations_applied': []
        }
        
        if preprocessing_level == 'minimal':
            # High-quality image: minimal processing
            result = self._minimal_preprocessing(img, processing_info)
        elif preprocessing_level == 'standard':
            # Medium-quality image: selective processing
            result = self._standard_preprocessing(img, processing_info)
        else:
            # Low-quality image: full processing pipeline
            result = self._heavy_preprocessing(img, processing_info)
        
        return result, processing_info
    
    def _minimal_preprocessing(self, img: np.ndarray, info: Dict) -> np.ndarray:
        """
        Minimal preprocessing for high-quality images
        Target: <0.5 seconds processing time
        """
        info['operations_applied'].append('minimal_resize_check')
        
        # Only ensure the image is in a suitable format for OCR
        # No denoising, no contrast enhancement, no skew correction
        
        # Convert to grayscale and back for consistency with PaddleOCR expectations
        if len(img.shape) == 3:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            result = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        else:
            result = img
        
        info['operations_applied'].append('format_normalization')
        return result
    
    def _standard_preprocessing(self, img: np.ndarray, info: Dict) -> np.ndarray:
        """
        Standard preprocessing for medium-quality images
        Target: <1.5 seconds processing time
        """
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        info['operations_applied'].append('grayscale_conversion')
        
        # Apply light contrast enhancement only if needed
        quality_metrics = info['quality_assessment']['metrics']
        if quality_metrics['contrast'] < 40:
            clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8, 8))
            gray = clahe.apply(gray)
            info['operations_applied'].append('light_clahe')
        
        # Light denoising only if noise level is significant
        if quality_metrics['noise_level'] > 8:
            gray = cv2.bilateralFilter(gray, 5, 50, 50)  # Lighter settings
            info['operations_applied'].append('light_denoising')
        
        # Convert back to color
        result = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        info['operations_applied'].append('color_conversion')
        
        return result
    
    def _heavy_preprocessing(self, img: np.ndarray, info: Dict) -> np.ndarray:
        """
        Full preprocessing pipeline for low-quality images
        Original full processing (2-3 seconds)
        """
        # This is the original preprocessing pipeline from paddleocr_service.py
        info['operations_applied'].append('full_preprocessing_pipeline')
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        info['operations_applied'].append('grayscale_conversion')
        
        # Apply adaptive histogram equalization
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)
        info['operations_applied'].append('clahe_enhancement')
        
        # Denoise while preserving edges
        denoised = cv2.bilateralFilter(enhanced, 9, 75, 75)
        info['operations_applied'].append('bilateral_denoising')
        
        # Detect and correct skew
        coords = np.column_stack(np.where(denoised > 0))
        if len(coords) > 100:
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            if abs(angle) > 0.5:
                (h, w) = denoised.shape[:2]
                center = (w // 2, h // 2)
                M = cv2.getRotationMatrix2D(center, angle, 1.0)
                denoised = cv2.warpAffine(denoised, M, (w, h),
                                        flags=cv2.INTER_CUBIC,
                                        borderMode=cv2.BORDER_REPLICATE)
                info['operations_applied'].append('skew_correction')
        
        # Convert back to color
        result = cv2.cvtColor(denoised, cv2.COLOR_GRAY2BGR)
        info['operations_applied'].append('color_conversion')
        
        # Sharpen text
        kernel = np.array([[-1, -1, -1],
                          [-1,  9, -1],
                          [-1, -1, -1]])
        sharpened = cv2.filter2D(result, -1, kernel)
        info['operations_applied'].append('sharpening')
        
        # Balance between sharpened and denoised
        final = cv2.addWeighted(result, 0.7, sharpened, 0.3, 0)
        info['operations_applied'].append('image_blending')
        
        return final

# Test function for validation
def test_smart_preprocessing():
    """Test function to validate smart preprocessing performance"""
    import time
    import os
    
    test_image = "/home/profusionai/CardMint/official_images/mcd19-12_large_ac9a28214284.jpg"
    
    if not os.path.exists(test_image):
        print("Test image not found - skipping test")
        return
    
    preprocessor = SmartPreprocessor()
    
    # Test all three levels
    for level in ['minimal', 'standard', 'heavy']:
        start_time = time.time()
        try:
            result, info = preprocessor.preprocess_image_smart(test_image, force_level=level)
            processing_time = time.time() - start_time
            
            print(f"\n{level.upper()} Preprocessing:")
            print(f"  Time: {processing_time:.3f}s")
            print(f"  Operations: {', '.join(info['operations_applied'])}")
            print(f"  Quality Score: {info['quality_assessment']['quality_score']:.2f}")
            
        except Exception as e:
            print(f"{level} preprocessing failed: {e}")

if __name__ == "__main__":
    test_smart_preprocessing()