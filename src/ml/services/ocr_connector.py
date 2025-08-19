"""
Connector to integrate ensemble with existing PaddleOCR service
Maintains separation of concerns while enhancing recognition
"""

import asyncio
import aiohttp
import numpy as np
from typing import Dict, List, Optional, Tuple
from pathlib import Path
import json
import logging
from dataclasses import dataclass
import base64
from PIL import Image
import io

logger = logging.getLogger(__name__)


@dataclass
class OCRResult:
    """OCR extraction result"""
    text: str
    confidence: float
    regions: List[Dict]
    card_name: Optional[str] = None
    set_info: Optional[str] = None
    card_number: Optional[str] = None
    hp: Optional[str] = None
    pokemon_type: Optional[str] = None
    attacks: List[str] = None


class PaddleOCRConnector:
    """
    Connector to existing PaddleOCR service
    Enhances OCR results with ensemble predictions
    """
    
    def __init__(self, ocr_service_url: str = "http://localhost:8181"):
        self.ocr_service_url = ocr_service_url
        self.session = None
        
    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()
    
    async def extract_text(self, image_path: str) -> OCRResult:
        """
        Extract text from image using existing PaddleOCR service
        Falls back gracefully if service is unavailable
        """
        
        try:
            # Read image and convert to base64
            with open(image_path, 'rb') as f:
                image_bytes = f.read()
            
            image_b64 = base64.b64encode(image_bytes).decode('utf-8')
            
            # Call PaddleOCR service
            if not self.session:
                self.session = aiohttp.ClientSession()
            
            async with self.session.post(
                f"{self.ocr_service_url}/ocr/extract",
                json={"image": image_b64},
                timeout=aiohttp.ClientTimeout(total=5)
            ) as response:
                
                if response.status == 200:
                    data = await response.json()
                    return self._parse_ocr_response(data)
                else:
                    logger.warning(f"OCR service returned {response.status}")
                    return self._mock_ocr_result()
                    
        except asyncio.TimeoutError:
            logger.warning("OCR service timeout - using fallback")
            return self._mock_ocr_result()
            
        except Exception as e:
            logger.error(f"OCR extraction failed: {e}")
            return self._mock_ocr_result()
    
    def _parse_ocr_response(self, data: Dict) -> OCRResult:
        """Parse PaddleOCR service response"""
        
        # Extract structured fields from OCR
        text_blocks = data.get('text_blocks', [])
        full_text = ' '.join([block['text'] for block in text_blocks])
        
        # Pokemon-specific extraction
        card_name = self._extract_card_name(text_blocks)
        set_info = self._extract_set_info(text_blocks)
        card_number = self._extract_card_number(text_blocks)
        hp = self._extract_hp(text_blocks)
        pokemon_type = self._extract_type(text_blocks)
        attacks = self._extract_attacks(text_blocks)
        
        return OCRResult(
            text=full_text,
            confidence=data.get('confidence', 0.0),
            regions=text_blocks,
            card_name=card_name,
            set_info=set_info,
            card_number=card_number,
            hp=hp,
            pokemon_type=pokemon_type,
            attacks=attacks
        )
    
    def _extract_card_name(self, text_blocks: List[Dict]) -> Optional[str]:
        """Extract Pokemon name from OCR text"""
        
        # Look for text in the header region
        header_blocks = [
            b for b in text_blocks 
            if b.get('region') == 'header' or b.get('y', 0) < 100
        ]
        
        if header_blocks:
            # Usually the largest text in header is the name
            return max(header_blocks, key=lambda x: x.get('font_size', 0)).get('text')
        
        return None
    
    def _extract_set_info(self, text_blocks: List[Dict]) -> Optional[str]:
        """Extract set information from OCR text"""
        
        # Look for patterns like "1/102" or "Base Set"
        for block in text_blocks:
            text = block.get('text', '')
            if '/' in text and any(c.isdigit() for c in text):
                return text
            if 'set' in text.lower():
                return text
        
        return None
    
    def _extract_card_number(self, text_blocks: List[Dict]) -> Optional[str]:
        """Extract card number from OCR text"""
        
        for block in text_blocks:
            text = block.get('text', '')
            # Look for pattern like "001/102"
            if '/' in text and all(c.isdigit() or c == '/' for c in text):
                return text
        
        return None
    
    def _extract_hp(self, text_blocks: List[Dict]) -> Optional[str]:
        """Extract HP value from OCR text"""
        
        for block in text_blocks:
            text = block.get('text', '').upper()
            if 'HP' in text:
                # Extract number before HP
                import re
                match = re.search(r'(\d+)\s*HP', text)
                if match:
                    return match.group(1)
        
        return None
    
    def _extract_type(self, text_blocks: List[Dict]) -> Optional[str]:
        """Extract Pokemon type from OCR text"""
        
        types = ['Fire', 'Water', 'Grass', 'Electric', 'Psychic', 'Fighting',
                 'Dark', 'Steel', 'Fairy', 'Dragon', 'Normal', 'Flying',
                 'Poison', 'Ground', 'Rock', 'Bug', 'Ghost', 'Ice']
        
        for block in text_blocks:
            text = block.get('text', '')
            for ptype in types:
                if ptype.lower() in text.lower():
                    return ptype
        
        return None
    
    def _extract_attacks(self, text_blocks: List[Dict]) -> List[str]:
        """Extract attack names from OCR text"""
        
        attacks = []
        
        # Look for attack patterns (usually in middle region)
        middle_blocks = [
            b for b in text_blocks
            if 200 < b.get('y', 0) < 400
        ]
        
        for block in middle_blocks:
            text = block.get('text', '')
            # Simple heuristic: attacks often have damage numbers
            if any(c.isdigit() for c in text) and len(text) > 5:
                attacks.append(text)
        
        return attacks[:2]  # Usually max 2 attacks
    
    def _mock_ocr_result(self) -> OCRResult:
        """Return mock OCR result when service unavailable"""
        
        return OCRResult(
            text="Mock OCR Text",
            confidence=0.0,
            regions=[],
            card_name="Unknown Card",
            set_info="Unknown Set",
            card_number="0/0"
        )


class OCREnhancer:
    """
    Enhances OCR results using ensemble predictions
    Combines text extraction with visual recognition
    """
    
    def __init__(self, ocr_connector: PaddleOCRConnector):
        self.ocr_connector = ocr_connector
        
    async def enhance_with_ensemble(
        self,
        ocr_result: OCRResult,
        ensemble_prediction: Dict
    ) -> Dict:
        """
        Combine OCR and ensemble results for better accuracy
        """
        
        # Start with OCR extracted data
        enhanced = {
            'card_name': ocr_result.card_name,
            'set_name': ocr_result.set_info,
            'card_number': ocr_result.card_number,
            'hp': ocr_result.hp,
            'type': ocr_result.pokemon_type,
            'attacks': ocr_result.attacks,
            'ocr_confidence': ocr_result.confidence,
            'ocr_text': ocr_result.text
        }
        
        # Enhance with ensemble predictions
        if ensemble_prediction:
            # If ensemble has high confidence, prefer its values
            if ensemble_prediction.get('confidence', 0) > 0.9:
                enhanced['card_name'] = ensemble_prediction.get('card_name', enhanced['card_name'])
                enhanced['set_name'] = ensemble_prediction.get('set_name', enhanced['set_name'])
            
            # Add ensemble confidence
            enhanced['ensemble_confidence'] = ensemble_prediction.get('confidence', 0)
            enhanced['combined_confidence'] = (
                ocr_result.confidence * 0.5 + 
                ensemble_prediction.get('confidence', 0) * 0.5
            )
        
        # Validate and clean data
        enhanced = self._validate_card_data(enhanced)
        
        return enhanced
    
    def _validate_card_data(self, data: Dict) -> Dict:
        """Validate and clean extracted card data"""
        
        # Ensure required fields
        data['card_name'] = data.get('card_name') or 'Unknown Pokemon'
        data['set_name'] = data.get('set_name') or 'Unknown Set'
        data['card_number'] = data.get('card_number') or '0/0'
        
        # Clean card name
        if data['card_name']:
            # Remove common OCR artifacts
            data['card_name'] = data['card_name'].replace('©', '').strip()
            
            # Capitalize properly
            data['card_name'] = ' '.join(
                word.capitalize() for word in data['card_name'].split()
            )
        
        # Validate card number format
        if data['card_number'] and '/' in data['card_number']:
            parts = data['card_number'].split('/')
            if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
                data['card_number'] = f"{int(parts[0])}/{int(parts[1])}"
        
        return data


async def process_with_ocr_enhancement(
    image_path: str,
    ensemble_prediction: Optional[Dict] = None
) -> Dict:
    """
    Main function to process image with OCR enhancement
    Integrates with existing PaddleOCR and new ensemble
    """
    
    async with PaddleOCRConnector() as ocr:
        # Get OCR results
        ocr_result = await ocr.extract_text(image_path)
        
        # Enhance with ensemble if available
        enhancer = OCREnhancer(ocr)
        enhanced_result = await enhancer.enhance_with_ensemble(
            ocr_result,
            ensemble_prediction or {}
        )
        
        return enhanced_result


if __name__ == "__main__":
    # Test the OCR connector
    async def test():
        result = await process_with_ocr_enhancement(
            "/home/profusionai/CardMint/captures/DSC00001.JPG"
        )
        print(json.dumps(result, indent=2))
    
    asyncio.run(test())