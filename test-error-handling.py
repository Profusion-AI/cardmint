#!/usr/bin/env python3
"""
Test enhanced FastAPI error handling and API Console integration
"""

import requests
import json
import time
import tempfile
import os

def test_error_scenarios():
    """Test various error scenarios to validate enhanced error handling"""
    base_url = "http://localhost:8000"
    
    print("🧪 Testing Enhanced FastAPI Error Handling")
    print("=" * 60)
    
    # Test 1: Missing file validation
    print("\n1️⃣  Testing missing file validation...")
    response = requests.post(f"{base_url}/api/recognize/lightweight")
    print(f"   Status: {response.status_code}")
    if response.status_code == 422:
        data = response.json()
        print(f"   ✅ Validation error handled correctly")
        print(f"   Message: {data.get('message', 'No message')}")
        print(f"   Body type: {data.get('body_type', 'Unknown')}")
        print(f"   Detail: {data.get('detail', [])}")
    
    # Test 2: Invalid file type
    print("\n2️⃣  Testing invalid file type...")
    with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
        f.write("This is not an image")
        txt_file = f.name
    
    try:
        with open(txt_file, 'rb') as f:
            files = {'file': ('test.txt', f, 'text/plain')}
            response = requests.post(f"{base_url}/api/recognize/lightweight", files=files)
        
        print(f"   Status: {response.status_code}")
        if response.status_code == 400:
            data = response.json()
            print(f"   ✅ File type validation handled correctly")
            print(f"   Error: {data.get('detail', 'No detail')}")
            print(f"   Service: {data.get('service', 'Unknown')}")
    finally:
        os.unlink(txt_file)
    
    # Test 3: File too small
    print("\n3️⃣  Testing file size validation...")
    with tempfile.NamedTemporaryFile(mode='wb', suffix='.jpg', delete=False) as f:
        f.write(b"tiny")  # Only 4 bytes
        small_file = f.name
    
    try:
        with open(small_file, 'rb') as f:
            files = {'file': ('tiny.jpg', f, 'image/jpeg')}
            response = requests.post(f"{base_url}/api/recognize/lightweight", files=files)
        
        print(f"   Status: {response.status_code}")
        if response.status_code == 400:
            data = response.json()
            print(f"   ✅ File size validation handled correctly")
            print(f"   Error: {data.get('detail', 'No detail')}")
    finally:
        os.unlink(small_file)
    
    # Test 4: Service health check (should succeed)
    print("\n4️⃣  Testing service health...")
    response = requests.get(f"{base_url}/")
    print(f"   Status: {response.status_code}")
    if response.status_code == 200:
        data = response.json()
        print(f"   ✅ Health check successful")
        print(f"   Service: {data.get('status', 'Unknown')}")
        print(f"   Ensemble ready: {data.get('ensemble_ready', False)}")
        print(f"   Models loaded: {len(data.get('models_loaded', []))}")
    
    # Test 5: Invalid endpoint
    print("\n5️⃣  Testing invalid endpoint...")
    response = requests.get(f"{base_url}/api/invalid-endpoint")
    print(f"   Status: {response.status_code}")
    if response.status_code == 404:
        print(f"   ✅ 404 handling working correctly")
    
    print("\n" + "=" * 60)
    print("🎯 Error handling tests completed!")
    print("\n💡 Check the API Console in the dashboard at:")
    print("   http://localhost:8081/ensemble-dashboard.html")
    print("   Navigate to the '🔧 API Console' tab to see error logs")

if __name__ == "__main__":
    test_error_scenarios()