#!/usr/bin/env python3
"""
FastAPI-based OCR Microservice for CardMint
High-performance persistent PaddleOCR service to eliminate initialization overhead
"""

import json
import time
import logging
from pathlib import Path
from typing import Dict, Optional
import uvicorn
from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import tempfile
import os

# Import existing OCR service
from paddleocr_service import CardOCRService

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from contextlib import asynccontextmanager

# Global variables
ocr_service: Optional[CardOCRService] = None
service_start_time = time.time()

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifespan"""
    global ocr_service
    
    # Startup
    logger.info("Initializing CardMint OCR Service...")
    start_time = time.time()
    
    try:
        # Initialize with high-performance inference enabled
        ocr_service = CardOCRService()
        # Pre-warm the service with a small test to ensure models are cached
        logger.info("Pre-warming OCR models...")
        
        # The OCR service will cache models on first use
        initialization_time = time.time() - start_time
        logger.info(f"OCR Service initialized successfully in {initialization_time:.2f} seconds")
        
    except Exception as e:
        logger.error(f"Failed to initialize OCR service: {e}")
        raise e
    
    yield  # Application runs here
    
    # Shutdown
    logger.info("Shutting down CardMint OCR Service...")
    ocr_service = None

# Initialize FastAPI app with lifespan
app = FastAPI(
    title="CardMint OCR Service",
    description="High-performance OCR service for Pokemon card processing",
    version="1.0.0",
    lifespan=lifespan
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Response models
class OCRResponse(BaseModel):
    success: bool
    processing_time_ms: float
    full_text: Optional[str] = None
    regions: Optional[list] = None
    avg_confidence: Optional[float] = None
    total_regions: Optional[int] = None
    requires_review: Optional[bool] = None
    extracted_card_info: Optional[dict] = None
    pass_number: Optional[int] = None
    high_accuracy_mode: Optional[bool] = None
    image_path: Optional[str] = None
    error: Optional[str] = None

class HealthResponse(BaseModel):
    status: str
    service: str
    version: str
    ocr_initialized: bool
    uptime_seconds: float

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint"""
    uptime = time.time() - service_start_time
    
    return HealthResponse(
        status="healthy",
        service="CardMint OCR Service",
        version="1.0.0", 
        ocr_initialized=ocr_service is not None,
        uptime_seconds=uptime
    )

@app.post("/ocr", response_model=OCRResponse)
async def process_ocr(
    file: UploadFile = File(...),
    high_accuracy: bool = True
):
    """
    Process an uploaded image with OCR
    
    Args:
        file: Image file (JPEG, PNG, etc.)
        high_accuracy: Whether to use high accuracy mode (default: True)
        
    Returns:
        OCR results with extracted card information
    """
    if ocr_service is None:
        raise HTTPException(
            status_code=503, 
            detail="OCR service not initialized"
        )
    
    # Validate file type
    if not file.content_type.startswith('image/'):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {file.content_type}. Only image files are supported."
        )
    
    start_time = time.time()
    temp_file_path = None
    
    try:
        # Save uploaded file to temporary location
        with tempfile.NamedTemporaryFile(delete=False, suffix='.jpg') as temp_file:
            content = await file.read()
            temp_file.write(content)
            temp_file_path = temp_file.name
        
        logger.info(f"Processing image: {file.filename} ({len(content)} bytes)")
        
        # Process with OCR service
        result = ocr_service.process_card(temp_file_path, high_accuracy)
        
        # Calculate processing time
        processing_time = (time.time() - start_time) * 1000  # Convert to milliseconds
        
        # Add processing time to result
        result['processing_time_ms'] = processing_time
        
        logger.info(f"OCR completed in {processing_time:.1f}ms - Success: {result.get('success', False)}")
        
        return OCRResponse(**result)
        
    except Exception as e:
        processing_time = (time.time() - start_time) * 1000
        logger.error(f"OCR processing failed after {processing_time:.1f}ms: {e}")
        
        return OCRResponse(
            success=False,
            processing_time_ms=processing_time,
            error=str(e)
        )
        
    finally:
        # Clean up temporary file
        if temp_file_path and os.path.exists(temp_file_path):
            try:
                os.unlink(temp_file_path)
            except Exception as e:
                logger.warning(f"Failed to cleanup temporary file {temp_file_path}: {e}")

@app.get("/metrics")
async def get_metrics():
    """Get service metrics"""
    uptime = time.time() - service_start_time
    
    return {
        "service": "CardMint OCR Service",
        "uptime_seconds": uptime,
        "ocr_service_status": "initialized" if ocr_service else "not_initialized",
        "memory_info": "Not implemented",  # Could add psutil for memory tracking
    }

if __name__ == "__main__":
    # Run the service
    logger.info("Starting CardMint OCR Service...")
    uvicorn.run(
        "ocr_service_fastapi:app",
        host="127.0.0.1",
        port=8000,
        reload=False,  # Disable reload to maintain service state
        log_level="info"
    )