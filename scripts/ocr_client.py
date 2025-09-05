#!/usr/bin/env python3
"""
OCR Daemon Client - Test client for the prewarmed OCR service

Usage:
    python scripts/ocr_client.py /path/to/image.png
    python scripts/ocr_client.py --health
    python scripts/ocr_client.py --status
"""
import argparse
import json
import requests
import sys
import time

def main():
    parser = argparse.ArgumentParser(description="OCR Daemon Client")
    parser.add_argument('image_path', nargs='?', help="Path to image file")
    parser.add_argument('--host', default='127.0.0.1', help="Daemon host")
    parser.add_argument('--port', type=int, default=8765, help="Daemon port")
    parser.add_argument('--health', action='store_true', help="Check health")
    parser.add_argument('--status', action='store_true', help="Get status")
    args = parser.parse_args()
    
    base_url = f"http://{args.host}:{args.port}"
    
    if args.health:
        try:
            response = requests.get(f"{base_url}/health", timeout=5)
            print(json.dumps(response.json(), indent=2))
        except Exception as e:
            print(f"Health check failed: {e}")
            sys.exit(1)
    
    elif args.status:
        try:
            response = requests.get(f"{base_url}/status", timeout=5)
            print(json.dumps(response.json(), indent=2))
        except Exception as e:
            print(f"Status check failed: {e}")
            sys.exit(1)
    
    elif args.image_path:
        try:
            start_time = time.time()
            
            payload = {"image_path": args.image_path}
            response = requests.post(f"{base_url}/ocr", json=payload, timeout=30)
            
            total_time = time.time() - start_time
            
            if response.status_code == 200:
                result = response.json()
                
                # Add client timing
                result['client_total_ms'] = round(total_time * 1000, 1)
                
                print(json.dumps(result, ensure_ascii=False, indent=2))
            else:
                print(f"Error {response.status_code}: {response.text}")
                sys.exit(1)
                
        except Exception as e:
            print(f"OCR request failed: {e}")
            sys.exit(1)
    
    else:
        parser.print_help()

if __name__ == "__main__":
    main()