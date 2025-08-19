# Archon + CardMint Integration Guide

## 🚀 Overview

This guide documents the integration between **Archon** (AI-powered knowledge management system) and **CardMint** (high-performance Pokemon card scanning system). This integration enhances development speed, code quality, and project management through intelligent knowledge retrieval and task tracking.

## 📊 System Status

### Archon Services (All Running ✅)
- **Archon-Server**: `http://localhost:8181` - Core API and business logic
- **Archon-UI**: `http://localhost:3737` - Web interface for knowledge and task management  
- **Archon-MCP**: `http://localhost:8051` - Model Context Protocol server for Claude Code
- **Archon-Agents**: `http://localhost:8052` - AI agents for advanced operations

### CardMint Current State (Phase 2A - OCR Integration)
- **Core Capture**: ✅ Sony SDK binary (400ms guaranteed performance) - **PRODUCTION READY**
- **OCR Pipeline**: ⚠️ PaddleOCR integrated with preprocessing - **FUNCTIONAL, NEEDS OPTIMIZATION**
- **REST API**: ✅ Card management endpoints at port 3000 - **WORKING**
- **WebSocket**: ✅ Real-time updates at port 3001 - **WORKING**
- **Database**: ✅ PostgreSQL with basic schema - **READY FOR ENHANCEMENT**
- **Pokemon TCG API**: ⚠️ Basic integration - **NEEDS EXPANSION**

### Development Focus Areas
- 🔧 **In Progress**: OCR accuracy improvements and preprocessing optimization
- 📋 **Uncommitted**: 5 modified files, 40+ new test/diagnostic files
- 🎯 **Next Phase**: Contextual embeddings and advanced card matching

## 🎯 Integration Benefits

### For CardMint Development
1. **Instant Knowledge Access**: All documentation, patterns, and solutions in one searchable place
2. **AI-Powered Assistance**: Claude Code can access your entire knowledge base via MCP
3. **Task Management**: Track features, bugs, and optimizations with project context
4. **Performance History**: Store and query benchmark results and optimization patterns
5. **Architectural Decisions**: Document and retrieve design choices with full context

### Key Use Cases
- **Debug OCR Issues**: Query past solutions and patterns
- **Optimize Performance**: Access benchmarks and successful optimizations
- **API Integration**: Retrieve working examples and error handling patterns
- **Camera Configuration**: Store and access Sony SDK configurations
- **Code Reviews**: Generate context-aware reviews with full project knowledge

## 🔧 Initial Setup

### Step 1: Configure Archon Web Interface

1. Open Archon UI: `http://localhost:3737`
2. Navigate to **Settings** page
3. Configure your LLM provider:
   - Select **OpenAI** (default) or your preferred provider
   - Enter your API key
   - Test the connection
4. Enable **Projects** feature for task management
5. Configure RAG settings:
   - Enable contextual embeddings for better search
   - Set chunk size to 1000 for technical documentation
   - Enable hybrid search for code + documentation

### Step 2: Upload CardMint Knowledge Base

Upload core documentation files to Archon:

```bash
# Navigate to Archon UI > Knowledge page
# Click "Upload Documents" and select:

/home/profusionai/CardMint/CLAUDE.md                    # Project context
/home/profusionai/CardMint/Core-Functionalities.md      # Architecture guide
/home/profusionai/CardMint/docs/CAMERA_SETUP.md         # Hardware config
/home/profusionai/CardMint/docs/CAPTURE_PROCESS_REQUIREMENTS.md
/home/profusionai/CardMint/docs/PC_REMOTE_CAPTURE_IMPLEMENTATION.md
/home/profusionai/CardMint/AUDIT_REPORT_2025_08_15.md   # Performance data
```

### Step 3: Crawl External Documentation

Add external resources via URL crawling:

1. **Pokemon TCG API**: `https://docs.pokemontcg.io`
2. **PaddleOCR Documentation**: `https://github.com/PaddlePaddle/PaddleOCR`
3. **BullMQ Documentation**: `https://docs.bullmq.io`
4. **Sony Camera Remote SDK**: Upload PDF documentation if available

### Step 4: Create CardMint Project

1. Navigate to **Projects** page in Archon UI
2. Create new project:
   - **Title**: "CardMint v1.0 Production System"
   - **GitHub**: `https://github.com/yourusername/CardMint`
   - **Description**: "High-performance Pokemon card scanning and inventory system"

3. Define project features:
   - Core Capture (Mission Critical)
   - OCR Processing Pipeline
   - API Integration Layer
   - Database Management
   - Performance Optimization

### Step 5: Import Current Tasks

Add immediate tasks to the project based on current development state:

```javascript
// Phase 2A Completion (Current Sprint)
- "Commit Phase 2A OCR Optimization changes" [Priority: High]
- "Test and validate OCR preprocessing pipeline" [Priority: High]
- "Document OCR confidence thresholds and patterns" [Priority: Medium]
- "Clean up 40+ untracked development files" [Priority: Medium]
- "Performance benchmark OCR vs capture timing" [Priority: High]

// Phase 2B Planning (Next Sprint)
- "Design contextual embedding architecture for card matching" [Priority: High]
- "Implement fuzzy matching for card name variations" [Priority: High]
- "Add card set identification from OCR results" [Priority: Medium]
- "Create preprocessing templates for different card conditions" [Priority: Medium]
- "Integrate advanced Pokemon TCG API features" [Priority: Medium]

// Technical Debt & Documentation
- "Document all sony-capture binary variants and use cases" [Priority: Low]
- "Create architectural decision records (ADRs)" [Priority: Medium]
- "Standardize error handling across all services" [Priority: Medium]
- "Optimize database schema for 1M+ cards" [Priority: Low]

// Feature Development Pipeline
- "Implement card grading estimation from image analysis" [Priority: Low]
- "Add support for Japanese Pokemon cards" [Priority: Low]
- "Create ML model for holographic pattern detection" [Priority: Low]
- "Build card price tracking and history" [Priority: Medium]
- "Develop mobile companion app API" [Priority: Low]
```

## 🔌 Claude Code MCP Integration

### Configure Claude Code Settings

Add to your Claude Code configuration (`.claude.json` or settings):

```json
{
  "mcpServers": {
    "archon": {
      "url": "http://localhost:8051",
      "transport": "sse",
      "tools": [
        "archon:perform_rag_query",
        "archon:search_code_examples",
        "archon:manage_project",
        "archon:manage_task",
        "archon:get_available_sources"
      ]
    }
  }
}
```

### Available MCP Tools

#### Knowledge Queries
```typescript
// Search documentation and patterns
archon:perform_rag_query({
  query: "OCR preprocessing optimization techniques",
  match_count: 5
})

// Find code examples
archon:search_code_examples({
  query: "Sony camera initialization pattern",
  match_count: 3
})
```

#### Task Management
```typescript
// Get current tasks
archon:manage_task({
  action: "list",
  filter_by: "status",
  filter_value: "todo"
})

// Update task status
archon:manage_task({
  action: "update",
  task_id: "task-123",
  update_fields: { status: "doing" }
})
```

## 🚀 Using Archon to Build CardMint Features

### Feature Development Strategy

Archon serves as the **central nervous system** for CardMint's evolution, providing:
- **Intelligent Context**: Every code change informed by historical patterns
- **Granular Tracking**: Every modification, test result, and decision recorded
- **Rapid Iteration**: Instant access to similar implementations and solutions
- **Quality Gates**: Automated checks against known best practices

### Current Development: OCR Enhancement Phase

#### What's Working Now
```typescript
// Core capture pipeline - DO NOT MODIFY without performance testing
const captureCard = async () => {
  // Sony SDK capture: 400-411ms guaranteed
  const imagePath = await sonyCaptureSDK.capture();
  
  // OCR processing: 1-3 seconds (needs optimization)
  const ocrResult = await paddleOCR.process(imagePath);
  
  // Basic API matching (needs expansion)
  const cardData = await pokemonTCG.match(ocrResult);
  
  return { imagePath, ocrResult, cardData };
};
```

#### What Needs Building (Tracked in Archon)
1. **OCR Accuracy Improvements**
   - Implement adaptive thresholding based on card condition
   - Add Pokemon-specific text patterns and fonts
   - Create preprocessing pipeline for foil/holographic cards
   - Build confidence scoring system

2. **API Integration Expansion**
   - Add TCGPlayer price data integration
   - Implement eBay recently sold matching
   - Create multi-source validation pipeline
   - Add card grading estimation

3. **Database Enhancements**
   - Design schema for card variations and conditions
   - Implement efficient similarity search
   - Add historical price tracking
   - Create user collection management

### Detailed Change Tracking with Archon

#### Every Code Change Documented
```markdown
# Task: Implement OCR Preprocessing Enhancement
## Changes Made
- File: src/ocr/preprocessor.ts
- Lines: 45-127
- Description: Added adaptive histogram equalization for low-light cards
- Performance Impact: +15% accuracy, +200ms processing time
- Trade-off: Accepted latency for accuracy gain in enhancement layer

## Test Results
- Test Suite: ocr-preprocessing.test.ts
- Pass Rate: 98% (49/50 tests passing)
- Failed Test: Holographic Charizard edge case
- Action Item: Create specific holographic preprocessing path

## Knowledge Captured
- Pattern: Use CLAHE for Pokemon cards with dark backgrounds
- Threshold: Confidence >85% for automatic acceptance
- Learning: Foil cards need separate preprocessing pipeline
```

#### Feature Branch Strategy
```bash
# Each feature tracked in Archon with:
1. Feature specification document
2. Technical design review notes
3. Implementation progress tracking
4. Test coverage reports
5. Performance benchmarks
6. Rollout plan and monitoring

# Example: OCR-Enhancement-2B
Branch: feature/ocr-contextual-embeddings
Archon Project: CardMint-OCR-2B
Tasks: 15 (3 complete, 5 in progress, 7 planned)
Knowledge Docs: 8 uploaded
Code Examples: 12 referenced
```

## 📋 Development Workflows

#### Morning Startup
1. Start Archon services: `cd ~/Archon && sudo docker compose up -d`
2. Open Archon UI: `http://localhost:3737`
3. Check task dashboard for priorities
4. Launch Claude Code with MCP connected
5. Query recent changes and context

#### Feature Development Flow
```bash
# 1. Check current task
archon:manage_task(action="list", filter_by="status", filter_value="todo")

# 2. Research implementation
archon:perform_rag_query(query="[feature] implementation patterns")

# 3. Find code examples
archon:search_code_examples(query="[specific technique]")

# 4. Implement with context
# ... development work ...

# 5. Update task status
archon:manage_task(action="update", task_id="...", update_fields={status:"review"})

# 6. Document learnings
# Upload new patterns or solutions to Archon
```

### Knowledge Capture Process

#### After Successful Optimization
1. Document the optimization in markdown
2. Include before/after performance metrics
3. Upload to Archon with tags: "optimization", "performance", "cardmint"
4. Link to relevant tasks

#### After Debugging Session
1. Create a troubleshooting guide
2. Include error messages, symptoms, and solution
3. Add code snippets that fixed the issue
4. Upload with tags: "debugging", "solutions", component name

### Performance Tracking

Store benchmark results in Archon for historical analysis:

```markdown
# Performance Test: 2025-08-18
## Configuration
- Camera: Sony ZV-E10M2
- Mode: PC Remote with SDK
- Workers: 20 parallel

## Results
- Capture Time: 411ms average
- OCR Processing: 1.2s average  
- End-to-end: 2.8s average
- Throughput: 147 cards/minute

## Optimizations Applied
- Disabled auto-review in camera
- Pre-allocated memory buffers
- GPU acceleration for OCR
```

## 🎨 Best Practices

### Knowledge Organization

1. **Use Consistent Tags**:
   - Component: `core-capture`, `ocr`, `api`, `database`
   - Type: `documentation`, `code-example`, `benchmark`, `troubleshooting`
   - Priority: `critical`, `enhancement`, `optimization`

2. **Document Patterns**:
   - Problem statement
   - Solution approach
   - Code implementation
   - Performance impact
   - Lessons learned

3. **Link Related Content**:
   - Cross-reference tasks with documentation
   - Connect code examples to features
   - Link benchmarks to optimizations

### Task Management

1. **Task Sizing**:
   - Keep tasks under 4 hours of work
   - Break large features into subtasks
   - Use clear, actionable titles

2. **Status Flow**:
   - `todo` → `doing` → `review` → `done`
   - Update status in real-time
   - Add notes when blocking issues arise

3. **Priority Management**:
   - Core functionality = Highest priority
   - Performance issues = High priority
   - Enhancements = Medium priority
   - Research = Low priority

## 🚨 Troubleshooting

### Common Issues

#### Archon Services Not Starting
```bash
# Check Docker status
sudo docker ps -a

# View logs
sudo docker logs Archon-Server
sudo docker logs Archon-MCP

# Restart services
cd ~/Archon && sudo docker compose restart
```

#### MCP Connection Failed
```bash
# Verify MCP is running
curl http://localhost:8051/health

# Check Claude Code config
cat ~/.claude.json

# Test with curl
curl -X POST http://localhost:8051/tools/perform_rag_query \
  -H "Content-Type: application/json" \
  -d '{"query": "test"}'
```

#### Knowledge Search Not Working
1. Check if documents are indexed
2. Verify embedding service is running
3. Ensure Supabase connection is active
4. Check API key configuration

## 📈 Advanced Features

### Custom MCP Tools for CardMint

Create specialized tools for CardMint operations:

```python
# In Archon MCP server, add custom tools:

@mcp_tool
async def capture_card_with_context():
    """Capture a card and retrieve relevant processing patterns"""
    # Trigger capture
    # Query similar card patterns
    # Return capture result with context
    
@mcp_tool  
async def analyze_ocr_failure():
    """Analyze OCR failure and suggest fixes"""
    # Get failed OCR result
    # Query knowledge base for similar issues
    # Suggest preprocessing adjustments
```

### Automated Knowledge Updates

Set up crawlers for automatic updates:

1. **Pokemon TCG Database**: Weekly crawl for new cards
2. **Sony SDK Updates**: Monitor for firmware/SDK releases
3. **Performance Benchmarks**: Auto-upload test results
4. **Error Patterns**: Collect and categorize common errors

### Integration with CI/CD

```yaml
# .github/workflows/archon-sync.yml
name: Sync with Archon
on:
  push:
    branches: [main]
jobs:
  update-knowledge:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Upload docs to Archon
        run: |
          curl -X POST http://archon-server:8181/api/knowledge/upload \
            -F "files=@docs/*.md"
      - name: Update task status
        run: |
          curl -X POST http://archon-server:8181/api/tasks/update \
            -d '{"commit": "${{ github.sha }}", "status": "completed"}'
```

## 🎯 Immediate Next Steps

### Today's Setup Checklist

1. **Configure Archon** (5 minutes)
   - [ ] Open http://localhost:3737
   - [ ] Add OpenAI API key in Settings
   - [ ] Enable Projects feature
   - [ ] Test with a simple query

2. **Upload CardMint Context** (10 minutes)
   - [ ] Upload CLAUDE.md for project context
   - [ ] Upload Core-Functionalities.md for architecture
   - [ ] Upload performance test results from Aug 15
   - [ ] Add OCR debugging notes

3. **Create Initial Project** (5 minutes)
   - [ ] Create "CardMint OCR Enhancement" project
   - [ ] Add current sprint tasks
   - [ ] Set task priorities based on Phase 2A/2B

4. **Connect Claude Code** (5 minutes)
   - [ ] Configure MCP server at localhost:8051
   - [ ] Test RAG query for "OCR optimization"
   - [ ] Verify task management works

5. **First Development Session** (ongoing)
   - [ ] Query: "OCR preprocessing patterns for Pokemon cards"
   - [ ] Create task: "Implement adaptive thresholding"
   - [ ] Document findings in Archon
   - [ ] Update task status as you progress

### This Week's Goals with Archon

**Monday-Tuesday**: OCR Pipeline Refinement
- Upload all OCR test results to Archon
- Query for similar preprocessing implementations
- Track confidence threshold experiments
- Document working patterns for different card types

**Wednesday-Thursday**: API Integration Expansion
- Research TCGPlayer API patterns in Archon
- Create tasks for each API endpoint needed
- Store successful authentication patterns
- Build error handling knowledge base

**Friday**: Performance Optimization & Documentation
- Upload all benchmark results
- Query for Node.js optimization patterns
- Document architectural decisions
- Plan Phase 2B based on learnings

## 🎯 Metrics and Success Indicators

### Development Velocity
- Time to find relevant documentation: < 10 seconds
- Context switching reduced by: 60%
- Bug resolution time: -40%
- Code reuse increased by: 35%

### Knowledge Coverage
- Documentation completeness: 95%
- Code examples per feature: 3+
- Troubleshooting guides: 20+
- Performance benchmarks: Daily

### Task Completion
- Average task cycle time: < 4 hours
- Tasks blocked rate: < 10%
- Documentation lag: < 1 day

## 📚 Additional Resources

- [Archon Documentation](https://github.com/coleam00/Archon)
- [MCP Protocol Specification](https://modelcontextprotocol.io)
- [CardMint Architecture Guide](./Core-Functionalities.md)
- [Sony Camera Remote SDK Documentation](./sony-sdk/docs)

## 🤝 Support and Contribution

### Getting Help
- Check Archon UI logs: Settings → Logs
- Review Docker container logs
- Consult knowledge base for similar issues
- Create detailed task with error context

### Contributing Back
- Document successful patterns
- Share performance optimizations
- Create reusable code examples
- Improve troubleshooting guides

---

*Last Updated: 2025-08-18*
*Version: 1.0.0*
*Status: Production Ready*