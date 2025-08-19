#!/usr/bin/env python3
"""
Hybrid VLM-OCR Pipeline with Shadow Mode Testing
Implements gradual rollout with performance monitoring and automatic fallback.
"""

import os
import sys
import time
import json
import hashlib
import asyncio
from typing import Dict, Any, Optional, Tuple, List
from datetime import datetime
from pathlib import Path
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError
import numpy as np

# Add parent directory to path
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, parent_dir)

from ml.smolvlm_service import SmolVLMService
from config.features_py import get_feature_flags, should_use_vlm

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class HybridPipeline:
    """
    Hybrid pipeline that can run VLM, OCR, or both in shadow mode.
    Implements safety features and performance monitoring.
    """
    
    def __init__(self,
                 enable_vlm: bool = None,
                 enable_shadow: bool = None,
                 vlm_timeout_s: float = 3.0,
                 ocr_timeout_s: float = 15.0,
                 cache_results: bool = True,
                 metrics_file: str = "baselines/hybrid-metrics.json"):
        """
        Initialize hybrid pipeline.
        
        Args:
            enable_vlm: Override for VLM enablement (None uses feature flags)
            enable_shadow: Override for shadow mode (None uses feature flags)
            vlm_timeout_s: Timeout for VLM inference
            ocr_timeout_s: Timeout for OCR processing
            cache_results: Whether to cache results
            metrics_file: Path to metrics file
        """
        self.vlm_timeout_s = vlm_timeout_s
        self.ocr_timeout_s = ocr_timeout_s
        self.cache_results = cache_results
        self.metrics_file = metrics_file
        
        # Feature flags (can be overridden)
        flags = get_feature_flags()
        self.enable_vlm = enable_vlm if enable_vlm is not None else flags["vlmEnabled"]
        self.enable_shadow = enable_shadow if enable_shadow is not None else flags["vlmShadowMode"]
        
        # Services
        self.vlm_service = None
        self.ocr_service = None
        
        # Cache
        self.cache = {}
        
        # Metrics
        self.metrics = {
            "vlm_success_count": 0,
            "vlm_failure_count": 0,
            "ocr_success_count": 0,
            "ocr_failure_count": 0,
            "vlm_total_time_ms": 0,
            "ocr_total_time_ms": 0,
            "shadow_mode_comparisons": [],
            "session_start": datetime.now().isoformat()
        }
        
        # Thread pool for parallel execution
        self.executor = ThreadPoolExecutor(max_workers=2)
        
        # Initialize services
        self._initialize_services()
        
    def _initialize_services(self):
        """Initialize VLM and OCR services as needed."""
        # Initialize VLM if enabled or in shadow mode
        if self.enable_vlm or self.enable_shadow:
            try:
                logger.info("Initializing SmolVLM service...")
                self.vlm_service = SmolVLMService(
                    device="cpu",
                    use_ipex=True,
                    quantize=False,  # Disabled - bitsandbytes not available
                    quantize_bits=8,
                    compile_model=True,
                    num_threads=4,
                    image_patches=2  # 1024x1024 for cards
                )
                logger.info("SmolVLM service initialized successfully")
            except Exception as e:
                logger.error(f"Failed to initialize VLM service: {e}")
                self.enable_vlm = False
                self.enable_shadow = False
        
        # Initialize OCR service (mock for now)
        self.ocr_service = self._create_mock_ocr_service()
        
    def _create_mock_ocr_service(self):
        """Create a mock OCR service for testing."""
        class MockOCRService:
            def recognize(self, image_path: str) -> Dict[str, Any]:
                """Mock OCR recognition."""
                import time
                import random
                
                # Simulate OCR processing time
                time.sleep(random.uniform(8, 12))
                
                # Mock result
                return {
                    "success": random.random() > 0.3,  # 70% success rate
                    "card_name": "Pikachu" if random.random() > 0.5 else "Charizard",
                    "card_set": "Base Set",
                    "card_number": f"{random.randint(1, 150)}/150",
                    "processing_time_ms": random.uniform(8000, 12000),
                    "method": "OCR"
                }
        
        return MockOCRService()
        
    def process_image(self, 
                      image_path: str,
                      request_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Process image through hybrid pipeline.
        
        Args:
            image_path: Path to image file
            request_id: Optional request ID for tracking
            
        Returns:
            Processing results
        """
        if not request_id:
            request_id = self._generate_request_id(image_path)
            
        # Check cache
        if self.cache_results and request_id in self.cache:
            logger.info(f"Cache hit for {request_id}")
            return self.cache[request_id]
        
        # Determine processing mode
        use_vlm = self.enable_vlm and should_use_vlm(request_id)
        
        if self.enable_shadow:
            # Shadow mode: Run both in parallel
            result = self._process_shadow_mode(image_path, request_id)
        elif use_vlm:
            # VLM only
            result = self._process_vlm(image_path, request_id)
        else:
            # OCR only (default/fallback)
            result = self._process_ocr(image_path, request_id)
        
        # Cache result
        if self.cache_results:
            self.cache[request_id] = result
            
        # Save metrics
        self._save_metrics()
        
        return result
        
    def _process_shadow_mode(self, 
                            image_path: str,
                            request_id: str) -> Dict[str, Any]:
        """
        Process in shadow mode - run both VLM and OCR in parallel.
        
        Args:
            image_path: Path to image
            request_id: Request ID
            
        Returns:
            OCR result (primary) with VLM comparison data
        """
        logger.info(f"Processing {request_id} in SHADOW MODE")
        
        # Submit both tasks
        vlm_future = self.executor.submit(self._process_vlm, image_path, request_id)
        ocr_future = self.executor.submit(self._process_ocr, image_path, request_id)
        
        # Get OCR result (primary)
        try:
            ocr_result = ocr_future.result(timeout=self.ocr_timeout_s)
        except TimeoutError:
            logger.error(f"OCR timeout for {request_id}")
            ocr_result = {
                "success": False,
                "error": "OCR timeout",
                "method": "OCR"
            }
        
        # Get VLM result (shadow)
        try:
            vlm_result = vlm_future.result(timeout=self.vlm_timeout_s)
        except TimeoutError:
            logger.warning(f"VLM timeout in shadow mode for {request_id}")
            vlm_result = {
                "success": False,
                "error": "VLM timeout",
                "method": "VLM"
            }
        except Exception as e:
            logger.warning(f"VLM error in shadow mode: {e}")
            vlm_result = {
                "success": False,
                "error": str(e),
                "method": "VLM"
            }
        
        # Compare results
        comparison = self._compare_results(ocr_result, vlm_result)
        self.metrics["shadow_mode_comparisons"].append({
            "request_id": request_id,
            "timestamp": datetime.now().isoformat(),
            "comparison": comparison
        })
        
        # Keep only last 100 comparisons
        if len(self.metrics["shadow_mode_comparisons"]) > 100:
            self.metrics["shadow_mode_comparisons"] = self.metrics["shadow_mode_comparisons"][-100:]
        
        # Log comparison
        if comparison["agreement"]:
            logger.info(f"Shadow mode: VLM and OCR AGREE on {comparison['card_name']}")
        else:
            logger.warning(f"Shadow mode: VLM and OCR DISAGREE - OCR: {comparison['ocr_name']}, VLM: {comparison['vlm_name']}")
        
        # Add shadow mode data to OCR result
        ocr_result["shadow_mode"] = {
            "vlm_result": vlm_result,
            "comparison": comparison
        }
        
        return ocr_result
        
    def _process_vlm(self, 
                    image_path: str,
                    request_id: str) -> Dict[str, Any]:
        """
        Process using VLM.
        
        Args:
            image_path: Path to image
            request_id: Request ID
            
        Returns:
            VLM processing result
        """
        if not self.vlm_service:
            logger.error("VLM service not initialized")
            return self._process_ocr(image_path, request_id)  # Fallback to OCR
        
        start_time = time.time()
        
        try:
            result = self.vlm_service.recognize_card(image_path, return_confidence=True)
            
            if result["success"]:
                self.metrics["vlm_success_count"] += 1
                self.metrics["vlm_total_time_ms"] += result["inference_time_ms"]
            else:
                self.metrics["vlm_failure_count"] += 1
                
            result["method"] = "VLM"
            result["request_id"] = request_id
            
            return result
            
        except Exception as e:
            logger.error(f"VLM processing failed: {e}")
            self.metrics["vlm_failure_count"] += 1
            
            # Fallback to OCR
            logger.info("Falling back to OCR due to VLM failure")
            return self._process_ocr(image_path, request_id)
            
    def _process_ocr(self, 
                    image_path: str,
                    request_id: str) -> Dict[str, Any]:
        """
        Process using OCR.
        
        Args:
            image_path: Path to image
            request_id: Request ID
            
        Returns:
            OCR processing result
        """
        start_time = time.time()
        
        try:
            result = self.ocr_service.recognize(image_path)
            
            if result["success"]:
                self.metrics["ocr_success_count"] += 1
                self.metrics["ocr_total_time_ms"] += result.get("processing_time_ms", 0)
            else:
                self.metrics["ocr_failure_count"] += 1
                
            result["method"] = "OCR"
            result["request_id"] = request_id
            
            return result
            
        except Exception as e:
            logger.error(f"OCR processing failed: {e}")
            self.metrics["ocr_failure_count"] += 1
            
            return {
                "success": False,
                "error": str(e),
                "method": "OCR",
                "request_id": request_id,
                "processing_time_ms": (time.time() - start_time) * 1000
            }
            
    def _compare_results(self, 
                        ocr_result: Dict[str, Any],
                        vlm_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Compare OCR and VLM results.
        
        Args:
            ocr_result: OCR processing result
            vlm_result: VLM processing result
            
        Returns:
            Comparison metrics
        """
        comparison = {
            "agreement": False,
            "ocr_success": ocr_result.get("success", False),
            "vlm_success": vlm_result.get("success", False),
            "ocr_name": ocr_result.get("card_name"),
            "vlm_name": vlm_result.get("card_name"),
            "ocr_time_ms": ocr_result.get("processing_time_ms", 0),
            "vlm_time_ms": vlm_result.get("inference_time_ms", 0),
            "speedup": None
        }
        
        # Check agreement on card name
        if comparison["ocr_name"] and comparison["vlm_name"]:
            # Simple string comparison (could be improved with fuzzy matching)
            comparison["agreement"] = (
                comparison["ocr_name"].lower().strip() == 
                comparison["vlm_name"].lower().strip()
            )
        
        # Calculate speedup
        if comparison["ocr_time_ms"] > 0 and comparison["vlm_time_ms"] > 0:
            comparison["speedup"] = comparison["ocr_time_ms"] / comparison["vlm_time_ms"]
        
        return comparison
        
    def _generate_request_id(self, image_path: str) -> str:
        """Generate unique request ID."""
        timestamp = str(time.time())
        path_hash = hashlib.md5(image_path.encode()).hexdigest()[:8]
        return f"{timestamp}-{path_hash}"
        
    def _save_metrics(self):
        """Save metrics to file."""
        try:
            os.makedirs(os.path.dirname(self.metrics_file), exist_ok=True)
            
            # Calculate averages
            vlm_total = self.metrics["vlm_success_count"] + self.metrics["vlm_failure_count"]
            ocr_total = self.metrics["ocr_success_count"] + self.metrics["ocr_failure_count"]
            
            metrics_summary = {
                **self.metrics,
                "vlm_success_rate": self.metrics["vlm_success_count"] / max(vlm_total, 1),
                "ocr_success_rate": self.metrics["ocr_success_count"] / max(ocr_total, 1),
                "vlm_avg_time_ms": self.metrics["vlm_total_time_ms"] / max(self.metrics["vlm_success_count"], 1),
                "ocr_avg_time_ms": self.metrics["ocr_total_time_ms"] / max(self.metrics["ocr_success_count"], 1),
                "last_updated": datetime.now().isoformat()
            }
            
            with open(self.metrics_file, "w") as f:
                json.dump(metrics_summary, f, indent=2)
                
        except Exception as e:
            logger.error(f"Failed to save metrics: {e}")
            
    def get_metrics(self) -> Dict[str, Any]:
        """Get current metrics."""
        vlm_total = self.metrics["vlm_success_count"] + self.metrics["vlm_failure_count"]
        ocr_total = self.metrics["ocr_success_count"] + self.metrics["ocr_failure_count"]
        
        return {
            "mode": "shadow" if self.enable_shadow else ("vlm" if self.enable_vlm else "ocr"),
            "vlm_enabled": self.enable_vlm,
            "shadow_mode": self.enable_shadow,
            "vlm_success_rate": self.metrics["vlm_success_count"] / max(vlm_total, 1),
            "ocr_success_rate": self.metrics["ocr_success_count"] / max(ocr_total, 1),
            "vlm_avg_time_ms": self.metrics["vlm_total_time_ms"] / max(self.metrics["vlm_success_count"], 1),
            "ocr_avg_time_ms": self.metrics["ocr_total_time_ms"] / max(self.metrics["ocr_success_count"], 1),
            "total_processed": vlm_total + ocr_total,
            "shadow_comparisons": len(self.metrics["shadow_mode_comparisons"])
        }
        
    def cleanup(self):
        """Clean up resources."""
        logger.info("Cleaning up hybrid pipeline...")
        
        # Save final metrics
        self._save_metrics()
        
        # Cleanup services
        if self.vlm_service:
            self.vlm_service.cleanup()
            
        # Shutdown executor
        self.executor.shutdown(wait=True)
        
        logger.info("Cleanup complete")


# Example usage and testing
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="Test hybrid VLM-OCR pipeline")
    parser.add_argument("--mode", choices=["ocr", "vlm", "shadow"], default="shadow",
                       help="Processing mode")
    parser.add_argument("--image", type=str, default="/home/profusionai/CardMint/test-images/test-card.jpg",
                       help="Image to process")
    args = parser.parse_args()
    
    # Initialize pipeline
    print(f"\n=== Initializing Hybrid Pipeline in {args.mode.upper()} mode ===")
    
    pipeline = HybridPipeline(
        enable_vlm=(args.mode in ["vlm", "shadow"]),
        enable_shadow=(args.mode == "shadow")
    )
    
    # Process image
    if os.path.exists(args.image):
        print(f"\nProcessing: {args.image}")
        result = pipeline.process_image(args.image)
        
        print("\n=== Result ===")
        print(f"Method: {result.get('method', 'Unknown')}")
        print(f"Success: {result.get('success', False)}")
        print(f"Card: {result.get('card_name', 'Unknown')}")
        print(f"Time: {result.get('processing_time_ms', 0):.1f}ms")
        
        if "shadow_mode" in result:
            comparison = result["shadow_mode"]["comparison"]
            print("\n=== Shadow Mode Comparison ===")
            print(f"Agreement: {comparison['agreement']}")
            print(f"OCR: {comparison['ocr_name']} ({comparison['ocr_time_ms']:.1f}ms)")
            print(f"VLM: {comparison['vlm_name']} ({comparison['vlm_time_ms']:.1f}ms)")
            if comparison["speedup"]:
                print(f"VLM Speedup: {comparison['speedup']:.2f}x")
    
    # Show metrics
    print("\n=== Pipeline Metrics ===")
    metrics = pipeline.get_metrics()
    for key, value in metrics.items():
        if isinstance(value, float):
            print(f"{key}: {value:.2f}")
        else:
            print(f"{key}: {value}")
    
    # Cleanup
    pipeline.cleanup()