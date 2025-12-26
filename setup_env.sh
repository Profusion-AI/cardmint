# CardMint Environment Variables
export OMP_NUM_THREADS=4
export MKL_NUM_THREADS=4
export OPENBLAS_NUM_THREADS=1
#September-Override legacy CPU config retained for archival testing
# Active GPU pipelines should set CARDMINT_CONFIG to the appropriate LM Studio profile
# Set OPENAI_API_KEY in your shell or .env file (never commit secrets)
export OPENAI_API_KEY=${OPENAI_API_KEY:-}
export CARDMINT_CONFIG=${CARDMINT_CONFIG:-path/to/dev_gpu_arc.yaml}
export CARDMINT_RETRIEVAL_DB=data/cardmint_dev.db
export CARDMINT_RETRIEVAL_TIMEOUT_MS=100
export CARDMINT_RETRIEVAL_MAX_CANDIDATES=50
