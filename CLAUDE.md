# Claude Prompting Notes (PRs)

This repository uses Claude Code GitHub Actions for advisory and security reviews.

Important:
- This top-level `CLAUDE.md` is intentionally NOT consumed by our GitHub Actions.
- The Actions are configured with explicit prompts stored under `.github/claude/`:
  - `.github/claude/ADVISORY_PROMPT.md`
  - `.github/claude/SECURITY_PROMPT.md`

Why not load from `CLAUDE.md`?
- Local Claude CLI tools may auto-read `CLAUDE.md` as a global system prompt.
- To avoid conflicts between local development and CI prompts, we keep PR-specific prompts in `.github/claude/` and pass them explicitly in workflows.

If you update our PR advisory/security style, edit the files in `.github/claude/` and not this notice.

## System Architecture & Resources

### Target Hardware Specifications
**CardMint is optimized for the following system configuration:**

- **CPU**: Intel x86_64 with AVX2 support (4C i5-10210U baseline)  
- **RAM**: 32GB total system memory (33,323,352,064 bytes)
- **GPU**: Intel UHD Graphics (CML GT2) with 24GB VRAM via Vulkan 1.3.283
  - Driver: Mesa 25.1.7 (Intel open-source Mesa driver)  
  - Total Memory Capacity: ~58GB combined RAM+VRAM
- **OS**: Linux (Fedora 42, kernel 6.16.3)

### Performance Targets
- **OCR Pipeline**: Sub-500ms response time
- **Throughput**: 60+ cards/minute processing rate  
- **Edge Deployment**: Full offline capability, no API dependencies

### AI/ML Capabilities
- **LMStudio**: Version 0.3.25 with EmbeddingGemma support
- **PaddleOCR**: PP-OCRv5 mobile models for text recognition
- **OpenVINO**: INT8 quantization support for inference acceleration
- **Embedding Models**: EmbeddingGemma 308M (Q4_0 quantized, ~229MB)

## Development Guidelines

### Code Standards
- Follow existing PaddleOCR integration patterns
- Optimize for Intel MKL-DNN CPU execution
- Target <200MB RAM overhead for ML models
- Maintain compatibility with AVX2 instruction sets

### Resource Constraints  
- Memory efficient: Models must fit in <500MB combined
- CPU optimized: Leverage AVX2 for vector operations
- Edge deployment: No cloud API dependencies
- Real-time: All operations <500ms end-to-end

## Important Instruction Reminders
Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.

