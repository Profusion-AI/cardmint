"""
CardMint Recognition API Service
FastAPI endpoints for the adaptive ensemble
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, HTTPException, BackgroundTasks, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from pydantic import BaseModel
from typing import Dict, List, Optional, Any
from pathlib import Path
import tempfile
import logging
import json
import time
import asyncio
from datetime import datetime
import redis
import hashlib

# Import our ensemble
import sys
sys.path.append(str(Path(__file__).parent.parent))
from ensemble import AdaptiveCardEnsemble, EnsembleResult, ModelType

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global variables
ensemble: Optional[AdaptiveCardEnsemble] = None
redis_client: Optional[redis.Redis] = None
startup_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manage application lifecycle events using the modern lifespan pattern.
    Replaces deprecated @app.on_event("startup") and @app.on_event("shutdown")
    """
    # Startup logic
    global ensemble, redis_client
    
    logger.info("🚀 Starting CardMint Recognition Service...")
    
    # Initialize Redis cache
    try:
        redis_client = redis.Redis(host='localhost', port=6379, db=1, decode_responses=True)
        redis_client.ping()
        logger.info("✅ Redis cache connected")
    except Exception as e:
        redis_client = None
        logger.warning(f"⚠️ Redis not available, caching disabled: {e}")
    
    # Initialize ensemble
    try:
        # Load ensemble with config
        config_path = Path(__file__).parent.parent / "config" / "ensemble_config.json"
        if not config_path.exists():
            # Create default config
            config_path.parent.mkdir(exist_ok=True)
            with open(config_path, 'w') as f:
                json.dump({
                    "enable_heavy_models": False,
                    "max_ram_mb": 4000,
                    "cache_enabled": True,
                    "progressive_enhancement": True,
                    "unified_pytorch": True  # New flag for unified architecture
                }, f, indent=2)
        
        ensemble = AdaptiveCardEnsemble(str(config_path))
        logger.info("✅ Ensemble initialized successfully")
        
    except Exception as e:
        logger.error(f"Failed to initialize ensemble: {e}")
        ensemble = None
    
    # Yield control to the application
    yield
    
    # Shutdown logic
    logger.info("🛑 Shutting down CardMint Recognition Service...")
    
    # Clean up Redis connection
    if redis_client:
        try:
            redis_client.close()
            logger.info("✅ Redis connection closed")
        except Exception as e:
            logger.error(f"Error closing Redis: {e}")
    
    # Clean up ensemble resources if needed
    if ensemble:
        logger.info("✅ Ensemble resources released")
    
    logger.info("👋 Recognition service shutdown complete")


# Initialize FastAPI app with lifespan
app = FastAPI(
    title="CardMint Recognition Service",
    description="Adaptive ML ensemble for Pokemon card recognition with PyTorch unified architecture",
    version="2.0.0",
    lifespan=lifespan  # Modern lifespan parameter
)

# CORS middleware for dashboard integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Custom exception handlers following FastAPI best practices
@app.exception_handler(RequestValidationError)
async def custom_validation_exception_handler(request: Request, exc: RequestValidationError):
    """
    Custom handler for request validation errors with detailed logging
    """
    logger.error(f"Request validation error on {request.url}: {exc.errors()}")
    
    # Handle FormData body safely for logging
    body_info = "FormData" if hasattr(exc.body, '__class__') and 'FormData' in str(type(exc.body)) else str(exc.body)
    logger.error(f"Request body type: {body_info}")
    
    # Return JSON-safe response
    return JSONResponse(
        status_code=422,
        content={
            "detail": exc.errors(),
            "body_type": body_info,
            "message": "Request validation failed - check file upload format and parameters"
        }
    )


@app.exception_handler(HTTPException)
async def custom_http_exception_handler(request: Request, exc: HTTPException):
    """
    Custom handler for HTTP exceptions with logging
    """
    logger.error(f"HTTP exception on {request.url}: {exc.status_code} - {exc.detail}")
    
    # Add custom headers for debugging
    headers = getattr(exc, 'headers', {})
    headers.update({"X-CardMint-Error": "recognition-service"})
    
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
            "status_code": exc.status_code,
            "service": "recognition"
        },
        headers=headers
    )


@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    """
    Catch-all exception handler for unexpected errors
    """
    logger.error(f"Unexpected error on {request.url}: {type(exc).__name__}: {str(exc)}")
    import traceback
    logger.error(f"Traceback: {traceback.format_exc()}")
    
    return JSONResponse(
        status_code=500,
        content={
            "detail": "Internal server error during card recognition",
            "error_type": type(exc).__name__,
            "service": "recognition"
        },
        headers={"X-CardMint-Error": "unexpected-error"}
    )


# Pydantic models for API
class RecognitionRequest(BaseModel):
    image_path: Optional[str] = None
    enable_cache: bool = True
    force_heavy_models: bool = False


class RecognitionResponse(BaseModel):
    success: bool
    card_id: str
    card_name: str
    set_name: str
    card_number: str
    rarity: str
    confidence: float
    ensemble_confidence: float
    inference_time_ms: float
    active_models: List[str]
    cached: bool = False
    timestamp: str
    
    # Additional fields for debugging and monitoring
    file_info: Optional[Dict[str, Any]] = None
    processing_stages: Optional[Dict[str, float]] = None
    
    class Config:
        json_schema_extra = {
            "example": {
                "success": True,
                "card_id": "blissey_2_64",
                "card_name": "Blissey", 
                "set_name": "Neo Genesis",
                "card_number": "2/64",
                "rarity": "Rare",
                "confidence": 0.95,
                "ensemble_confidence": 0.92,
                "inference_time_ms": 850.5,
                "active_models": ["mobilenet", "orb", "paddle_ocr"],
                "cached": False,
                "timestamp": "2025-08-18T21:52:00Z",
                "file_info": {
                    "filename": "blissey.jpg",
                    "size_bytes": 245760,
                    "content_type": "image/jpeg"
                },
                "processing_stages": {
                    "ocr_ms": 600.2,
                    "mobilenet_ms": 120.1,
                    "orb_ms": 45.3,
                    "ensemble_ms": 84.9
                }
            }
        }


class ModelStatus(BaseModel):
    active_models: List[str]
    available_models: List[str]
    resource_usage: Dict[str, Any]
    can_enable_heavy_models: bool


class HealthCheck(BaseModel):
    status: str
    ensemble_ready: bool
    redis_connected: bool
    models_loaded: List[str]
    uptime_seconds: float


# Utility functions
def compute_image_hash(image_bytes: bytes) -> str:
    """Compute hash of image for caching"""
    return hashlib.md5(image_bytes).hexdigest()


async def cache_prediction(image_hash: str, result: Dict, ttl: int = 3600):
    """Cache prediction result in Redis"""
    if redis_client:
        try:
            redis_client.setex(
                f"card:prediction:{image_hash}",
                ttl,
                json.dumps(result)
            )
        except Exception as e:
            logger.error(f"Cache write failed: {e}")


async def get_cached_prediction(image_hash: str) -> Optional[Dict]:
    """Get cached prediction from Redis"""
    if redis_client:
        try:
            cached = redis_client.get(f"card:prediction:{image_hash}")
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.error(f"Cache read failed: {e}")
    return None


# API Endpoints

@app.get("/", response_model=HealthCheck)
async def health_check():
    """Health check endpoint"""
    return HealthCheck(
        status="healthy" if ensemble else "degraded",
        ensemble_ready=ensemble is not None,
        redis_connected=redis_client is not None,
        models_loaded=ensemble.get_status()['active_models'] if ensemble else [],
        uptime_seconds=time.time() - startup_time
    )


@app.post("/api/recognize/lightweight", response_model=RecognitionResponse)
async def recognize_lightweight(
    file: UploadFile = File(..., description="Pokemon card image to recognize (JPEG/PNG)"),
    enable_cache: bool = True
):
    """
    Fast recognition using only lightweight models (MobileNet + ORB)
    Target: 1-2 second response time on CPU
    """
    
    logger.info(f"=== RECOGNIZE API CALLED === File: {file.filename if file else 'None'}")
    
    if not ensemble:
        logger.error("Ensemble not initialized!")
        raise HTTPException(
            status_code=503, 
            detail="ML ensemble not initialized - service starting up",
            headers={"Retry-After": "30"}
        )
    
    # Validate file upload
    if not file or not file.filename:
        raise HTTPException(
            status_code=400,
            detail="No file provided or empty filename",
            headers={"X-CardMint-Error": "missing-file"}
        )
    
    # Validate file type
    allowed_types = {"image/jpeg", "image/png", "image/jpg"}
    if file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid file type: {file.content_type}. Allowed types: {', '.join(allowed_types)}",
            headers={"X-CardMint-Error": "invalid-file-type"}
        )
    
    # Check file size (max 10MB)
    file_size = 0
    content = await file.read()
    await file.seek(0)  # Reset file pointer for later processing
    file_size = len(content)
    
    if file_size > 10 * 1024 * 1024:  # 10MB limit
        raise HTTPException(
            status_code=413,
            detail=f"File too large: {file_size / (1024*1024):.1f}MB. Maximum size: 10MB",
            headers={"X-CardMint-Error": "file-too-large"}
        )
    
    if file_size < 1024:  # Minimum 1KB
        raise HTTPException(
            status_code=400,
            detail=f"File too small: {file_size} bytes. Minimum size: 1KB",
            headers={"X-CardMint-Error": "file-too-small"}
        )
    
    logger.info(f"File validation passed: {file.filename} ({file_size} bytes, {file.content_type})")
    
    start_time = time.time()
    
    # Read and hash image
    image_bytes = await file.read()
    image_hash = compute_image_hash(image_bytes)
    
    # Check cache
    if enable_cache:
        cached = await get_cached_prediction(image_hash)
        if cached:
            cached['cached'] = True
            cached['inference_time_ms'] = (time.time() - start_time) * 1000
            return RecognitionResponse(**cached)
    
    # Save image temporarily
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    
    try:
        logger.info(f"Calling ensemble.predict with image at {tmp_path}")
        # Run ensemble prediction
        result = ensemble.predict(tmp_path)
        logger.info(f"Ensemble returned: final_prediction={result.final_prediction.card_name if result.final_prediction else 'None'}, confidence={result.ensemble_confidence:.3f}, time={result.total_time_ms:.1f}ms")
        
        # Log model predictions
        for model_name, pred in result.model_predictions.items():
            logger.info(f"  {model_name}: {pred.card_name} (conf: {pred.confidence:.3f}, time: {pred.inference_time_ms:.1f}ms)")
        
        # Prepare enhanced response with file info and processing stages
        processing_stages = {}
        for model_name, pred in result.model_predictions.items():
            processing_stages[f"{model_name}_ms"] = pred.inference_time_ms
        
        response_data = {
            "success": True,
            "card_id": result.final_prediction.card_id if result.final_prediction else "unknown",
            "card_name": result.final_prediction.card_name if result.final_prediction else "Unknown Card",
            "set_name": result.final_prediction.set_name if result.final_prediction else "Unknown Set",
            "card_number": result.final_prediction.card_number if result.final_prediction else "0/0",
            "rarity": result.final_prediction.rarity if result.final_prediction else "unknown",
            "confidence": result.final_prediction.confidence if result.final_prediction else 0.0,
            "ensemble_confidence": result.ensemble_confidence,
            "inference_time_ms": result.total_time_ms,
            "active_models": result.active_models,
            "cached": False,
            "timestamp": datetime.now().isoformat(),
            "file_info": {
                "filename": file.filename,
                "size_bytes": file_size,
                "content_type": file.content_type
            },
            "processing_stages": processing_stages
        }
        
        # Cache result
        if enable_cache:
            await cache_prediction(image_hash, response_data)
        
        logger.info(f"=== RECOGNIZE API COMPLETE === Total time: {(time.time() - start_time)*1000:.1f}ms")
        return RecognitionResponse(**response_data)
        
    except Exception as e:
        logger.error(f"Recognition failed: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))
        
    finally:
        # Clean up temp file
        Path(tmp_path).unlink(missing_ok=True)


@app.post("/api/recognize/full")
async def recognize_full(
    file: UploadFile = File(...),
    force_heavy_models: bool = False
):
    """
    Full ensemble recognition (when heavy models are available)
    This endpoint will attempt to use TripletResNet101 and ViT if resources allow
    """
    
    if not ensemble:
        raise HTTPException(status_code=503, detail="Ensemble not initialized")
    
    # Try to enable heavy models if requested
    if force_heavy_models and not ensemble.model_registry[ModelType.TRIPLET_RESNET]['active']:
        success = ensemble.enable_heavy_models()
        if not success:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "Heavy models not available",
                    "reason": "Insufficient resources or GPU not available",
                    "fallback": "Use /api/recognize/lightweight endpoint"
                }
            )
    
    # Process same as lightweight for now
    return await recognize_lightweight(file=file, enable_cache=True)


@app.get("/api/models/status", response_model=ModelStatus)
async def get_model_status():
    """Get current status of all models in the ensemble"""
    
    if not ensemble:
        raise HTTPException(status_code=503, detail="Ensemble not initialized")
    
    status = ensemble.get_status()
    
    # Check if we can enable heavy models
    # Now checks for any accelerated device (GPU/XPU/MPS), not just CUDA
    can_enable = (
        ensemble.resource_monitor.device.type != "cpu" and
        ensemble.resource_monitor.get_available_ram_mb() > 4000
    )
    
    return ModelStatus(
        active_models=status['active_models'],
        available_models=status['available_models'],
        resource_usage=status['resource_usage'],
        can_enable_heavy_models=can_enable
    )


@app.post("/api/models/enable/{model_type}")
async def enable_model(model_type: str):
    """Enable a specific model if resources allow"""
    
    if not ensemble:
        raise HTTPException(status_code=503, detail="Ensemble not initialized")
    
    try:
        model_enum = ModelType(model_type)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid model type: {model_type}")
    
    if model_enum in [ModelType.TRIPLET_RESNET, ModelType.VIT]:
        success = ensemble.enable_heavy_models()
        if not success:
            raise HTTPException(
                status_code=503,
                detail="Cannot enable heavy models - insufficient resources"
            )
    
    return {"success": True, "model": model_type, "status": "enabled"}


@app.post("/api/models/disable/{model_type}")
async def disable_model(model_type: str):
    """Disable a specific model to free resources"""
    
    if not ensemble:
        raise HTTPException(status_code=503, detail="Ensemble not initialized")
    
    try:
        model_enum = ModelType(model_type)
        if model_enum in ensemble.model_registry:
            ensemble.model_registry[model_enum]['active'] = False
            ensemble.model_registry[model_enum]['model'] = None
            return {"success": True, "model": model_type, "status": "disabled"}
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Invalid model type: {model_type}")


@app.get("/api/cache/stats")
async def get_cache_stats():
    """Get cache statistics"""
    
    if not redis_client:
        return {"cache_enabled": False}
    
    try:
        keys = redis_client.keys("card:prediction:*")
        return {
            "cache_enabled": True,
            "cached_predictions": len(keys),
            "cache_size_estimate_mb": len(keys) * 0.01  # Rough estimate
        }
    except Exception as e:
        return {"cache_enabled": False, "error": str(e)}


@app.delete("/api/cache/clear")
async def clear_cache():
    """Clear all cached predictions"""
    
    if not redis_client:
        return {"success": False, "reason": "Cache not available"}
    
    try:
        keys = redis_client.keys("card:prediction:*")
        if keys:
            redis_client.delete(*keys)
        return {"success": True, "cleared": len(keys)}
    except Exception as e:
        return {"success": False, "error": str(e)}


# WebSocket endpoint for real-time updates (future enhancement)
@app.websocket("/ws/recognition")
async def websocket_recognition(websocket):
    """WebSocket for streaming recognition updates"""
    await websocket.accept()
    
    try:
        while True:
            # Receive image data
            data = await websocket.receive_bytes()
            
            # Process with ensemble
            # Send progress updates
            await websocket.send_json({
                "status": "processing",
                "model": "mobilenet",
                "progress": 0.33
            })
            
            # Send final result
            await websocket.send_json({
                "status": "complete",
                "confidence": 0.95
            })
            
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        await websocket.close()


if __name__ == "__main__":
    import uvicorn
    
    # Run the service with proper module string for reload support
    uvicorn.run(
        "recognition_service:app",  # Use import string for reload to work
        host="0.0.0.0",
        port=8000,
        log_level="info",
        reload=True,
        reload_dirs=["../", "./"]  # Watch both API and ML directories
    )