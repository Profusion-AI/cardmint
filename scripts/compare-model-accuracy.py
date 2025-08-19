#!/usr/bin/env python3
"""
Compare accuracy between original and trained SmolVLM models
Provides detailed analysis of improvements and regressions
"""

import sys
import os
import json
import time
import argparse
from pathlib import Path
from PIL import Image
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import defaultdict

# Add parent directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class ModelComparator:
    """Compare two SmolVLM models on the same test set."""
    
    def __init__(self, original_model_path, trained_model_path):
        """Initialize comparator with model paths."""
        self.original_model_path = original_model_path
        self.trained_model_path = trained_model_path
        self.original_service = None
        self.trained_service = None
        
    def load_models(self):
        """Load both models."""
        logger.info("Loading models...")
        
        try:
            from src.ml.smolvlm_optimized_service import OptimizedSmolVLMService
            
            # Load original model
            logger.info("Loading original model...")
            self.original_service = OptimizedSmolVLMService(
                model_path=self.original_model_path
            )
            
            # Load trained model
            logger.info("Loading trained model...")
            self.trained_service = OptimizedSmolVLMService(
                model_path=self.trained_model_path
            )
            
            logger.info("✅ Both models loaded successfully")
            return True
            
        except Exception as e:
            logger.error(f"❌ Failed to load models: {e}")
            return False
            
    def test_single_image(self, image_path, expected_name=None):
        """Test single image on both models."""
        results = {
            'image_path': image_path,
            'expected_name': expected_name,
            'original': {},
            'trained': {},
            'comparison': {}
        }
        
        try:
            # Test original model
            start_time = time.time()
            original_result = self.original_service.process_image(image_path)
            original_time = time.time() - start_time
            
            results['original'] = {
                'inference_time': original_time,
                'card_name': original_result.get('card_name', ''),
                'confidence': original_result.get('confidence', 0),
                'full_result': original_result
            }
            
            # Test trained model
            start_time = time.time()
            trained_result = self.trained_service.process_image(image_path)
            trained_time = time.time() - start_time
            
            results['trained'] = {
                'inference_time': trained_time,
                'card_name': trained_result.get('card_name', ''),
                'confidence': trained_result.get('confidence', 0),
                'full_result': trained_result
            }
            
            # Compare results
            results['comparison'] = self._compare_results(
                results['original'], 
                results['trained'], 
                expected_name
            )
            
        except Exception as e:
            logger.error(f"Error testing {image_path}: {e}")
            results['error'] = str(e)
            
        return results
        
    def _compare_results(self, original, trained, expected_name):
        """Compare results from both models."""
        comparison = {}
        
        # Speed comparison
        speed_diff = original['inference_time'] - trained['inference_time']
        comparison['speed_improvement'] = speed_diff
        comparison['speed_percentage'] = (speed_diff / original['inference_time']) * 100
        
        # Confidence comparison
        conf_diff = trained['confidence'] - original['confidence']
        comparison['confidence_improvement'] = conf_diff
        
        # Accuracy comparison (if expected name provided)
        if expected_name:
            original_correct = self._is_correct(original['card_name'], expected_name)
            trained_correct = self._is_correct(trained['card_name'], expected_name)
            
            comparison['original_correct'] = original_correct
            comparison['trained_correct'] = trained_correct
            
            if trained_correct and not original_correct:
                comparison['accuracy_change'] = 'improved'
            elif original_correct and not trained_correct:
                comparison['accuracy_change'] = 'regressed'
            elif trained_correct and original_correct:
                comparison['accuracy_change'] = 'both_correct'
            else:
                comparison['accuracy_change'] = 'both_wrong'
        
        return comparison
        
    def _is_correct(self, predicted_name, expected_name):
        """Check if prediction matches expected name."""
        if not predicted_name or not expected_name:
            return False
            
        predicted = predicted_name.lower().strip()
        expected = expected_name.lower().strip()
        
        # Exact match
        if predicted == expected:
            return True
            
        # Partial match (either contains the other)
        if expected in predicted or predicted in expected:
            return True
            
        return False
        
    def run_comparison(self, test_images, max_workers=2):
        """Run comparison on multiple images."""
        logger.info(f"Running comparison on {len(test_images)} images...")
        
        all_results = []
        
        # Process images with limited parallelism
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            # Submit all tasks
            future_to_image = {
                executor.submit(self.test_single_image, img_path, expected): (img_path, expected)
                for img_path, expected in test_images
            }
            
            # Collect results
            for future in as_completed(future_to_image):
                img_path, expected = future_to_image[future]
                try:
                    result = future.result()
                    all_results.append(result)
                    logger.info(f"✅ Completed: {os.path.basename(img_path)}")
                except Exception as e:
                    logger.error(f"❌ Failed: {img_path} - {e}")
                    
        return all_results
        
    def generate_report(self, results, output_path=None):
        """Generate comprehensive comparison report."""
        report = {
            'summary': self._generate_summary(results),
            'detailed_results': results,
            'recommendations': self._generate_recommendations(results)
        }
        
        if output_path:
            with open(output_path, 'w') as f:
                json.dump(report, f, indent=2, default=str)
            logger.info(f"📊 Report saved to: {output_path}")
            
        return report
        
    def _generate_summary(self, results):
        """Generate summary statistics."""
        valid_results = [r for r in results if 'error' not in r]
        
        if not valid_results:
            return {'error': 'No valid results to analyze'}
            
        summary = {
            'total_tests': len(results),
            'successful_tests': len(valid_results),
            'failed_tests': len(results) - len(valid_results),
        }
        
        # Speed analysis
        speed_improvements = [r['comparison']['speed_improvement'] for r in valid_results]
        summary['speed'] = {
            'average_improvement': sum(speed_improvements) / len(speed_improvements),
            'median_improvement': sorted(speed_improvements)[len(speed_improvements)//2],
            'faster_count': sum(1 for x in speed_improvements if x > 0),
            'slower_count': sum(1 for x in speed_improvements if x < 0)
        }
        
        # Confidence analysis
        conf_improvements = [r['comparison']['confidence_improvement'] for r in valid_results]
        summary['confidence'] = {
            'average_improvement': sum(conf_improvements) / len(conf_improvements),
            'median_improvement': sorted(conf_improvements)[len(conf_improvements)//2],
            'improved_count': sum(1 for x in conf_improvements if x > 0.05),
            'degraded_count': sum(1 for x in conf_improvements if x < -0.05)
        }
        
        # Accuracy analysis (only for results with expected names)
        accuracy_results = [r for r in valid_results if r['expected_name']]
        if accuracy_results:
            accuracy_changes = [r['comparison']['accuracy_change'] for r in accuracy_results]
            accuracy_counts = defaultdict(int)
            for change in accuracy_changes:
                accuracy_counts[change] += 1
                
            summary['accuracy'] = dict(accuracy_counts)
            summary['accuracy']['total_with_ground_truth'] = len(accuracy_results)
            
            # Calculate improvement rate
            improved = accuracy_counts['improved']
            regressed = accuracy_counts['regressed']
            total_changeable = improved + regressed + accuracy_counts['both_wrong']
            
            if total_changeable > 0:
                summary['accuracy']['improvement_rate'] = improved / total_changeable
                summary['accuracy']['regression_rate'] = regressed / total_changeable
                
        return summary
        
    def _generate_recommendations(self, results):
        """Generate recommendations based on results."""
        summary = self._generate_summary(results)
        recommendations = []
        
        # Speed recommendations
        avg_speed_improvement = summary['speed']['average_improvement']
        if avg_speed_improvement > 1.0:
            recommendations.append("✅ Significant speed improvement detected. Trained model is faster.")
        elif avg_speed_improvement < -1.0:
            recommendations.append("⚠️ Speed regression detected. Consider enabling optimizations.")
        else:
            recommendations.append("ℹ️ Speed performance is similar between models.")
            
        # Confidence recommendations
        avg_conf_improvement = summary['confidence']['average_improvement']
        if avg_conf_improvement > 0.1:
            recommendations.append("✅ Confidence scores significantly improved.")
        elif avg_conf_improvement < -0.1:
            recommendations.append("⚠️ Confidence scores degraded. Review confidence calculation.")
        else:
            recommendations.append("ℹ️ Confidence scores remain similar.")
            
        # Accuracy recommendations
        if 'accuracy' in summary:
            improvement_rate = summary['accuracy'].get('improvement_rate', 0)
            regression_rate = summary['accuracy'].get('regression_rate', 0)
            
            if improvement_rate > 0.15:  # 15% improvement
                recommendations.append("✅ Strong accuracy improvement. Recommend deployment.")
            elif improvement_rate > 0.08:  # 8% improvement
                recommendations.append("✅ Good accuracy improvement. Proceed with deployment.")
            elif regression_rate > 0.1:  # 10% regression
                recommendations.append("❌ Significant accuracy regression. Do not deploy.")
            else:
                recommendations.append("⚠️ Limited accuracy change. Consider dataset validation only.")
                
        return recommendations
        
    def close(self):
        """Close model services."""
        if self.original_service:
            self.original_service.close()
        if self.trained_service:
            self.trained_service.close()

def main():
    parser = argparse.ArgumentParser(description="Compare SmolVLM model accuracy")
    parser.add_argument("--original-model", required=True, help="Path to original model")
    parser.add_argument("--trained-model", required=True, help="Path to trained model")
    parser.add_argument("--test-images", required=True, help="Directory with test images")
    parser.add_argument("--expected-names", help="JSON file with expected names")
    parser.add_argument("--output", help="Output file for results")
    parser.add_argument("--max-workers", type=int, default=2, help="Max parallel workers")
    
    args = parser.parse_args()
    
    # Load expected names if provided
    expected_names = {}
    if args.expected_names and os.path.exists(args.expected_names):
        with open(args.expected_names, 'r') as f:
            expected_names = json.load(f)
            
    # Find test images
    test_images = []
    test_dir = Path(args.test_images)
    
    if test_dir.is_dir():
        for img_path in test_dir.glob("*.{png,jpg,jpeg}"):
            expected_name = expected_names.get(img_path.name)
            test_images.append((str(img_path), expected_name))
    else:
        logger.error(f"Test images directory not found: {test_dir}")
        sys.exit(1)
        
    logger.info(f"Found {len(test_images)} test images")
    
    # Run comparison
    comparator = ModelComparator(args.original_model, args.trained_model)
    
    try:
        if not comparator.load_models():
            sys.exit(1)
            
        results = comparator.run_comparison(test_images, args.max_workers)
        report = comparator.generate_report(results, args.output)
        
        # Print summary
        print("\n" + "="*60)
        print("MODEL COMPARISON SUMMARY")
        print("="*60)
        
        summary = report['summary']
        print(f"Tests completed: {summary['successful_tests']}/{summary['total_tests']}")
        
        if 'speed' in summary:
            speed = summary['speed']
            print(f"Average speed improvement: {speed['average_improvement']:.2f}s")
            print(f"Faster in {speed['faster_count']} cases, slower in {speed['slower_count']} cases")
            
        if 'confidence' in summary:
            conf = summary['confidence']
            print(f"Average confidence improvement: {conf['average_improvement']:.3f}")
            
        if 'accuracy' in summary:
            acc = summary['accuracy']
            print(f"Accuracy changes: {acc}")
            
        print("\nRecommendations:")
        for rec in report['recommendations']:
            print(f"  {rec}")
            
    finally:
        comparator.close()

if __name__ == "__main__":
    main()