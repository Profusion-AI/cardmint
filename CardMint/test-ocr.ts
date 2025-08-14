#!/usr/bin/env tsx
/**
 * Test script for PaddleOCR integration
 * Tests OCR accuracy on card images
 */

import { OCRService } from './src/ocr/OCRService';
import { ImageProcessor } from './src/processing/ImageProcessor';
import { createLogger } from './src/utils/logger';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('ocr-test');

async function testOCRService() {
  console.log('\n=== PaddleOCR Integration Test ===\n');
  
  // Initialize OCR service with high accuracy mode
  const ocrService = new OCRService(true, 0.85);
  
  // Test with a sample image (we'll create a test image)
  const testImagePath = path.join(__dirname, 'test-card.jpg');
  
  // Check if we have a test image, if not create a placeholder
  try {
    await fs.access(testImagePath);
    console.log(`✅ Using existing test image: ${testImagePath}`);
  } catch {
    console.log('⚠️  No test image found. Please provide a card image at test-card.jpg');
    console.log('   You can capture one using: npm run camera:capture');
    
    // Create a simple test image with text for OCR testing
    console.log('\n📝 Creating synthetic test image with text...');
    await createSyntheticTestImage(testImagePath);
  }
  
  // Test 1: Direct OCR Service
  console.log('\n1. Testing OCR Service directly...');
  const startTime = Date.now();
  const ocrResult = await ocrService.processImage(testImagePath);
  const ocrTime = Date.now() - startTime;
  
  if (ocrResult.success) {
    console.log(`   ✅ OCR completed in ${ocrTime}ms`);
    console.log(`   📊 Average confidence: ${((ocrResult.avg_confidence || 0) * 100).toFixed(1)}%`);
    console.log(`   📝 Regions detected: ${ocrResult.total_regions}`);
    console.log(`   ⚠️  Requires review: ${ocrResult.requires_review ? 'Yes' : 'No'}`);
    
    if (ocrResult.extracted_card_info) {
      console.log('\n   Extracted Card Information:');
      console.log(`   - Card Name: ${ocrResult.extracted_card_info.card_name || 'Not detected'}`);
      console.log(`   - Card Set: ${ocrResult.extracted_card_info.card_set || 'Not detected'}`);
      console.log(`   - Card Number: ${ocrResult.extracted_card_info.card_number || 'Not detected'}`);
      console.log(`   - Rarity: ${ocrResult.extracted_card_info.rarity || 'Not detected'}`);
    }
    
    if (ocrResult.regions && ocrResult.regions.length > 0) {
      console.log('\n   Top 3 text regions:');
      ocrResult.regions.slice(0, 3).forEach((region, i) => {
        console.log(`   ${i + 1}. "${region.text}" (${(region.confidence * 100).toFixed(1)}% confidence)`);
      });
    }
  } else {
    console.log(`   ❌ OCR failed: ${ocrResult.error}`);
  }
  
  // Test 2: Validation
  console.log('\n2. Testing validation system...');
  const validation = ocrService.validateResults(ocrResult);
  console.log(`   Valid: ${validation.isValid ? '✅' : '❌'}`);
  console.log(`   Requires Review: ${validation.requiresReview ? '⚠️ Yes' : '✅ No'}`);
  if (validation.issues.length > 0) {
    console.log('   Issues found:');
    validation.issues.forEach(issue => console.log(`   - ${issue}`));
  }
  
  // Test 3: Image Processor Integration
  console.log('\n3. Testing ImageProcessor integration...');
  const processor = new ImageProcessor();
  const processingResult = await processor.process({
    cardId: 'test-001',
    imageData: testImagePath,
    settings: {
      ocrEnabled: true,
      generateThumbnail: false,
      enhanceImage: false,
    }
  });
  
  if (processingResult.ocrData) {
    console.log(`   ✅ OCR integrated successfully`);
    console.log(`   📊 Overall confidence: ${(processingResult.ocrData.confidence * 100).toFixed(1)}%`);
    console.log(`   ⏱️  Processing time: ${processingResult.ocrData.processingTimeMs}ms`);
  }
  
  if (processingResult.metadata) {
    console.log('\n   Final Card Metadata:');
    console.log(`   - Name: ${processingResult.metadata.cardName}`);
    console.log(`   - Set: ${processingResult.metadata.cardSet}`);
    console.log(`   - Number: ${processingResult.metadata.cardNumber}`);
    console.log(`   - Rarity: ${processingResult.metadata.rarity}`);
    console.log(`   - Condition: ${processingResult.metadata.condition}`);
    console.log(`   - Language: ${processingResult.metadata.language}`);
  }
  
  // Performance summary
  console.log('\n=== Performance Summary ===');
  console.log(`Total OCR time: ${ocrTime}ms`);
  console.log(`Confidence achieved: ${((ocrResult.avg_confidence || 0) * 100).toFixed(1)}%`);
  console.log(`Target confidence: 98%`);
  
  const meetsTarget = (ocrResult.avg_confidence || 0) >= 0.98;
  console.log(`\n${meetsTarget ? '✅' : '⚠️'} ${meetsTarget ? 'Meets' : 'Below'} 98% accuracy target`);
  
  if (!meetsTarget && ocrResult.avg_confidence) {
    const gap = 98 - (ocrResult.avg_confidence * 100);
    console.log(`   Gap to target: ${gap.toFixed(1)}%`);
    console.log('\n   Recommendations to improve accuracy:');
    console.log('   - Ensure good lighting when capturing cards');
    console.log('   - Keep cards flat and aligned');
    console.log('   - Use higher resolution capture settings');
    console.log('   - Clean camera lens if needed');
  }
}

async function createSyntheticTestImage(outputPath: string) {
  // Create a simple test image using canvas (if available) or a basic approach
  // For now, we'll use Python to create a test image
  const pythonScript = `
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Create a white background
img = np.ones((600, 400, 3), dtype=np.uint8) * 255

# Add some test text that looks like a card
cv2.putText(img, "Lightning Dragon", (50, 80), cv2.FONT_HERSHEY_DUPLEX, 1.2, (0, 0, 0), 2)
cv2.putText(img, "Legendary Creature - Dragon", (50, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (50, 50, 50), 1)
cv2.putText(img, "When Lightning Dragon enters the battlefield,", (30, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
cv2.putText(img, "deal 3 damage to any target.", (30, 230), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
cv2.putText(img, "Flying, Haste", (30, 280), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1)
cv2.putText(img, "5/5", (320, 500), cv2.FONT_HERSHEY_DUPLEX, 1, (0, 0, 0), 2)
cv2.putText(img, "123/350", (30, 550), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (100, 100, 100), 1)
cv2.putText(img, "Mythic Rare", (250, 550), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (150, 100, 0), 1)

# Add a border
cv2.rectangle(img, (10, 10), (390, 590), (0, 0, 0), 2)

# Save the image
cv2.imwrite("${outputPath}", img)
print("Test image created")
`;

  const scriptPath = '/tmp/create_test_image.py';
  await fs.writeFile(scriptPath, pythonScript);
  
  const { spawn } = await import('child_process');
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('python3', [scriptPath]);
    proc.on('close', (code) => {
      if (code === 0) {
        console.log('   ✅ Synthetic test image created');
        resolve();
      } else {
        reject(new Error(`Failed to create test image: exit code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// Run the test
testOCRService().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});