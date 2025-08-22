#!/usr/bin/env python3

"""
Mock ML Server for Testing
Simulates the M4 Mac ML server responses for testing purposes
"""

from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse
import hashlib
import time
import random
from datetime import datetime
from typing import Optional
import uvicorn

app = FastAPI(title="Mock CardMint ML Server")

# Simulated cache
cache = {}
start_time = time.time()

# Mock card data
MOCK_CARDS = {
    "blissey": {
        "card_id": "ex2-2",
        "name": "Blissey",
        "hp": 120,
        "type": "Colorless",
        "stage": "Stage 1",
        "set_number": "2/64",
        "rarity": "Rare Holo",
        "evolves_from": "Chansey",
        "attacks": [
            {"name": "Double-edge", "damage": 80, "cost": ["Colorless", "Colorless", "Colorless", "Colorless"]}
        ]
    },
    "pikachu": {
        "card_id": "base1-58",
        "name": "Pikachu",
        "hp": 60,
        "type": "Lightning",
        "stage": "Basic",
        "set_number": "58/102",
        "rarity": "Common"
    },
    "charizard": {
        "card_id": "base1-4",
        "name": "Charizard",
        "hp": 120,
        "type": "Fire",
        "stage": "Stage 2",
        "set_number": "4/102",
        "rarity": "Rare Holo",
        "evolves_from": "Charmeleon"
    }
}

@app.get("/status")
async def health_check():
    """Health check endpoint"""
    uptime = int(time.time() - start_time)
    return {
        "status": "healthy",
        "ensemble_ready": True,
        "models_loaded": ["smolvlm", "mobilenet", "yolo"],
        "uptime_seconds": uptime,
        "resources": {
            "cpu_percent": random.uniform(10, 30),
            "memory_mb": random.randint(2000, 3500)
        },
        "queue": {
            "depth": random.randint(0, 5),
            "processing": random.randint(0, 2)
        }
    }

@app.post("/identify")
async def identify_card(
    image: UploadFile = File(...),
    request_id: Optional[str] = Form(None)
):
    """Card identification endpoint"""
    
    # Read image data to generate hash
    image_data = await image.read()
    image_hash = hashlib.sha256(image_data).hexdigest()
    
    # Simulate processing delay for non-cached requests
    if image_hash not in cache:
        # First request takes 2-3 seconds
        processing_time = random.uniform(2.0, 3.0)
        time.sleep(processing_time)
        
        # Randomly select a card or return high confidence for known images
        if "blissey" in image.filename.lower():
            card_data = MOCK_CARDS["blissey"]
            confidence = random.uniform(0.92, 0.98)
        elif "pikachu" in image.filename.lower():
            card_data = MOCK_CARDS["pikachu"]
            confidence = random.uniform(0.90, 0.96)
        elif "charizard" in image.filename.lower():
            card_data = MOCK_CARDS["charizard"]
            confidence = random.uniform(0.88, 0.94)
        else:
            # Generic card
            card_data = random.choice(list(MOCK_CARDS.values()))
            confidence = random.uniform(0.75, 0.85)
        
        # Cache the result
        cache[image_hash] = {
            "card_data": card_data,
            "confidence": confidence,
            "timestamp": datetime.now().isoformat()
        }
        cached = False
    else:
        # Cached request is very fast
        time.sleep(random.uniform(0.002, 0.005))
        cached_result = cache[image_hash]
        card_data = cached_result["card_data"]
        confidence = cached_result["confidence"]
        cached = True
    
    return {
        "success": True,
        "card_id": card_data["card_id"],
        "card_name": card_data["name"],
        "confidence": confidence,
        "cached": cached,
        "card_data": card_data,
        "request_id": request_id,
        "processing_ms": random.randint(2000, 3000) if not cached else random.randint(2, 5)
    }

@app.get("/inventory")
async def get_inventory():
    """Inventory endpoint"""
    return {
        "cards": [
            {
                "id": card["card_id"],
                "name": card["name"],
                "count": random.randint(1, 5)
            }
            for card in MOCK_CARDS.values()
        ],
        "total_cards": sum(random.randint(1, 5) for _ in MOCK_CARDS),
        "database_status": "connected",
        "cache_stats": {
            "hits": len(cache),
            "size_mb": len(cache) * 0.1
        }
    }

if __name__ == "__main__":
    print("🚀 Starting Mock ML Server on port 5001...")
    print("📍 This simulates the M4 Mac ML server for testing")
    print("✨ Access at: http://localhost:5001")
    uvicorn.run(app, host="0.0.0.0", port=5001)