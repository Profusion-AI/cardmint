#!/usr/bin/env python3
"""
Image Resizing Test for Qwen2.5-VL Optimization
Tests different image resolutions to find optimal balance between speed and accuracy
"""

import os
import sys
import time
import json
import base64
import requests
from pathlib import Path
from PIL import Image
import io

# Configuration
MAC_SERVER = "http://10.0.24.174:1234/v1/chat/completions"
# TEST_IMAGE = Path.home() / "CardMint" / "blissey_simple.jpg"
TEST_IMAGE = Path.home() / "CardMint" / "test_highres.jpg"  # 26MP Sony capture
OUTPUT_DIR = Path.home() / "CardMint" / "resize-tests"

# Test resolutions (width in pixels, height auto-calculated)
TEST_RESOLUTIONS = [
    (640, "Small - Fast"),
    (800, "Dashboard size"),
    (1024, "Medium"),
    (1280, "Current Qwen default"),
    (1600, "High detail"),
    (1920, "Full HD"),
    (2560, "Very high detail"),
    (None, "Original (26MP)")
]

def resize_image(image_path, max_width=None):
    """Resize image maintaining aspect ratio."""
    with Image.open(image_path) as img:
        if max_width is None:
            return img.copy()
        
        # Calculate new height maintaining aspect ratio
        aspect_ratio = img.height / img.width
        new_width = min(max_width, img.width)
        new_height = int(new_width * aspect_ratio)
        
        # Resize using high-quality Lanczos filter
        return img.resize((new_width, new_height), Image.Resampling.LANCZOS)

def encode_image(img):
    """Encode PIL image to base64."""
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=90)
    return base64.b64encode(buffer.getvalue()).decode('utf-8')

def test_recognition(img_base64, resolution_name):
    """Test card recognition at given resolution."""
    headers = {
        "Content-Type": "application/json"
    }
    
    prompt = """Identify this Pokemon card. Provide:
    - Card name
    - Set name
    - Card number
    - Rarity
    - Any special variants (1st edition, shadowless, etc.)
    
    Format as JSON with confidence score (0-1)."""
    
    data = {
        "model": "lmstudio-community/Qwen2.5-VL-7B-Instruct-GGUF",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img_base64}"}}
                ]
            }
        ],
        "temperature": 0.3,
        "max_tokens": 500
    }
    
    start_time = time.time()
    
    try:
        response = requests.post(MAC_SERVER, headers=headers, json=data, timeout=60)
        processing_time = time.time() - start_time
        
        if response.status_code == 200:
            result = response.json()
            content = result['choices'][0]['message']['content']
            
            # Try to parse JSON from response
            try:
                # Extract JSON if embedded in text
                import re
                json_match = re.search(r'\{.*\}', content, re.DOTALL)
                if json_match:
                    card_data = json.loads(json_match.group())
                else:
                    card_data = {"raw_response": content}
            except:
                card_data = {"raw_response": content}
            
            return {
                "success": True,
                "processing_time": processing_time,
                "data": card_data,
                "resolution": resolution_name
            }
        else:
            return {
                "success": False,
                "error": f"API error: {response.status_code}",
                "processing_time": processing_time,
                "resolution": resolution_name
            }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "processing_time": time.time() - start_time,
            "resolution": resolution_name
        }

def calculate_file_size(img):
    """Calculate approximate file size of image."""
    buffer = io.BytesIO()
    img.save(buffer, format='JPEG', quality=90)
    return len(buffer.getvalue())

def main():
    """Run image resizing tests."""
    print("🔬 CardMint Image Resizing Test for Qwen2.5-VL")
    print("=" * 60)
    
    # Check if test image exists
    if not TEST_IMAGE.exists():
        print(f"❌ Test image not found: {TEST_IMAGE}")
        print("Please ensure blissey_simple.jpg exists in ~/CardMint/")
        sys.exit(1)
    
    # Create output directory
    OUTPUT_DIR.mkdir(exist_ok=True)
    
    # Load original image
    original_img = Image.open(TEST_IMAGE)
    print(f"📷 Original image: {original_img.width}x{original_img.height}")
    print(f"   Format: {original_img.format}, Mode: {original_img.mode}")
    print()
    
    # Test connectivity first
    print("🔗 Testing Mac server connectivity...")
    try:
        test_response = requests.get("http://10.0.24.174:1234/v1/models", timeout=5)
        if test_response.status_code == 200:
            print("✅ Connected to LM Studio")
        else:
            print(f"⚠️ Server responded with status {test_response.status_code}")
    except Exception as e:
        print(f"❌ Cannot connect to Mac server: {e}")
        print("Please ensure LM Studio is running on 10.0.24.174:1234")
        sys.exit(1)
    
    print("\n" + "=" * 60)
    print("📊 Running resolution tests...")
    print("=" * 60 + "\n")
    
    results = []
    
    for width, description in TEST_RESOLUTIONS:
        if width is None:
            print(f"🎯 Testing: Original resolution - {description}")
            resized_img = original_img.copy()
            resolution_str = f"{original_img.width}x{original_img.height}"
        else:
            print(f"🎯 Testing: {width}px width - {description}")
            resized_img = resize_image(TEST_IMAGE, width)
            resolution_str = f"{resized_img.width}x{resized_img.height}"
        
        # Calculate file size
        file_size = calculate_file_size(resized_img)
        file_size_mb = file_size / (1024 * 1024)
        
        print(f"   Resolution: {resolution_str}")
        print(f"   File size: {file_size_mb:.2f} MB")
        
        # Save test image
        test_filename = OUTPUT_DIR / f"test_{width or 'original'}.jpg"
        resized_img.save(test_filename, quality=90)
        
        # Test recognition
        print("   Processing with Qwen2.5-VL...", end="", flush=True)
        img_base64 = encode_image(resized_img)
        result = test_recognition(img_base64, resolution_str)
        
        if result["success"]:
            print(f" ✅ {result['processing_time']:.2f}s")
            
            # Extract key data
            if isinstance(result["data"], dict):
                card_name = result["data"].get("name", result["data"].get("card_name", "Unknown"))
                confidence = result["data"].get("confidence", "N/A")
                print(f"   Card identified: {card_name}")
                print(f"   Confidence: {confidence}")
            else:
                print(f"   Response: {str(result['data'])[:100]}...")
        else:
            print(f" ❌ Failed")
            print(f"   Error: {result['error']}")
        
        # Store result
        results.append({
            "width": width,
            "description": description,
            "resolution": resolution_str,
            "file_size_mb": round(file_size_mb, 2),
            "processing_time": round(result["processing_time"], 2),
            "success": result["success"],
            "data": result.get("data", {})
        })
        
        print()
        
        # Small delay between tests
        time.sleep(2)
    
    # Save results
    results_file = OUTPUT_DIR / "test_results.json"
    with open(results_file, 'w') as f:
        json.dump(results, f, indent=2)
    
    # Print summary
    print("\n" + "=" * 60)
    print("📈 TEST SUMMARY")
    print("=" * 60)
    print()
    print("| Width  | Resolution    | Size (MB) | Time (s) | Status |")
    print("|--------|---------------|-----------|----------|--------|")
    
    for r in results:
        status = "✅" if r["success"] else "❌"
        width_str = str(r["width"]) if r["width"] else "Orig"
        print(f"| {width_str:6} | {r['resolution']:13} | {r['file_size_mb']:9.2f} | {r['processing_time']:8.2f} | {status:6} |")
    
    # Find optimal resolution
    successful_results = [r for r in results if r["success"]]
    if successful_results:
        # Sort by processing time
        fastest = min(successful_results, key=lambda x: x["processing_time"])
        
        # Find sweet spot (under 5 seconds, over 1024px)
        sweet_spot = [r for r in successful_results 
                     if r["processing_time"] < 5 and (r["width"] or 0) >= 1024]
        
        print("\n📊 RECOMMENDATIONS:")
        print(f"   Fastest: {fastest['resolution']} ({fastest['processing_time']}s)")
        
        if sweet_spot:
            optimal = sweet_spot[0]
            print(f"   Optimal: {optimal['resolution']} ({optimal['processing_time']}s, {optimal['file_size_mb']}MB)")
            print(f"   ➡️ Recommend using {optimal['width'] or 'original'}px width for best balance")
        else:
            print(f"   ➡️ Recommend using {fastest['width'] or 'original'}px width for speed")
    
    print(f"\n💾 Full results saved to: {results_file}")
    print(f"📁 Test images saved to: {OUTPUT_DIR}")
    
    print("\n✅ Image resizing test complete!")

if __name__ == "__main__":
    main()