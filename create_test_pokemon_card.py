#!/usr/bin/env python3
"""Create a synthetic Pokemon card image for testing OCR"""

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

def create_pokemon_card_image():
    """Create a synthetic Pokemon card image that mimics real card layout"""
    
    # Create white card background
    width, height = 400, 560
    img = np.ones((height, width, 3), dtype=np.uint8) * 255
    
    # Add card border
    cv2.rectangle(img, (10, 10), (width-10, height-10), (200, 200, 200), 2)
    
    # Card header section (name and HP)
    # Pokemon name - larger font, positioned at top
    cv2.putText(img, "Blissey", (30, 50), cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 0, 0), 2)
    
    # HP value - top right
    cv2.putText(img, "HP 120", (width-100, 50), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    
    # Stage indicator
    cv2.putText(img, "Stage 1", (30, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)
    
    # Evolution text
    cv2.putText(img, "Evolves from Chansey", (100, 80), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    
    # Card artwork area (just a rectangle)
    cv2.rectangle(img, (30, 100), (width-30, 250), (230, 230, 230), -1)
    cv2.putText(img, "[Card Art]", (width//2-40, 175), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (150, 150, 150), 1)
    
    # Attack 1
    cv2.putText(img, "Double-Edge", (30, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "120", (width-60, 290), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "This Pokemon also does 80 damage to itself", (30, 315), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (50, 50, 50), 1)
    
    # Attack 2  
    cv2.putText(img, "Softboiled", (30, 350), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
    cv2.putText(img, "Heal 30 damage from this Pokemon", (30, 375), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (50, 50, 50), 1)
    
    # Weakness/Resistance line
    cv2.putText(img, "Weakness", (30, 420), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "Fighting x2", (100, 420), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    
    cv2.putText(img, "Retreat Cost", (220, 420), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "CCC", (320, 420), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    
    # Card number and rarity
    cv2.putText(img, "2/64", (30, 520), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    cv2.putText(img, "Rare Holo", (width//2-30, 520), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
    
    # Illustrator
    cv2.putText(img, "Illus. Test Artist", (width-120, 520), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (100, 100, 100), 1)
    
    return img

# Create and save test card
img = create_pokemon_card_image()
cv2.imwrite('/home/profusionai/CardMint/blissey_synthetic.jpg', img)
print("Created synthetic Blissey card at: /home/profusionai/CardMint/blissey_synthetic.jpg")

# Also create a simpler version with clearer text
simple_img = np.ones((600, 400, 3), dtype=np.uint8) * 255

# Very clear card name at top
cv2.putText(simple_img, "Blissey", (50, 60), cv2.FONT_HERSHEY_DUPLEX, 1.5, (0, 0, 0), 3)
cv2.putText(simple_img, "HP 120", (280, 60), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
cv2.putText(simple_img, "Stage 1 Pokemon", (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (50, 50, 50), 1)

# Card number
cv2.putText(simple_img, "2/64", (50, 550), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)

cv2.imwrite('/home/profusionai/CardMint/blissey_simple.jpg', simple_img)
print("Created simple Blissey card at: /home/profusionai/CardMint/blissey_simple.jpg")