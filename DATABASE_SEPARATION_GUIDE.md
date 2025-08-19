# Database Separation Guide: Archon vs CardMint

## 🔒 Critical: Two Completely Separate Database Systems

### 1. Archon Knowledge Database (Supabase)
- **Purpose**: Knowledge management, documentation, RAG, task tracking
- **Provider**: Supabase Cloud
- **Instance**: `rstdauvmrqmtuagkffgy.supabase.co`
- **Access**: Via Archon MCP server at `localhost:8051`
- **Contents**:
  - Documentation and guides
  - Code examples and patterns
  - Task and project management
  - Knowledge embeddings for RAG
  - Crawled external documentation

**NEVER store CardMint production data here!**

### 2. CardMint Production Database (Fly.io PostgreSQL)
- **Purpose**: Production card data and operations
- **Provider**: Fly.io Managed PostgreSQL
- **Cluster**: `gjpkdon11dy0yln4`
- **Access**: 
  - Local: `localhost:16380` (via fly proxy)
  - Production: `pgbouncer.gjpkdon11dy0yln4.flympg.net`
- **Contents**:
  - Card inventory records
  - Capture metadata
  - OCR results
  - Pricing data
  - User collections
  - Transaction history

**NEVER store documentation or knowledge here!**

## 🎯 Clear Boundaries

### When to Use Archon's Supabase:
```typescript
// ✅ CORRECT: Documentation queries
archon:perform_rag_query({ query: "OCR optimization patterns" })

// ✅ CORRECT: Code examples
archon:search_code_examples({ query: "Sony SDK initialization" })

// ✅ CORRECT: Task management
archon:manage_task({ action: "create", title: "Implement new feature" })
```

### When to Use CardMint's Fly.io PostgreSQL:
```typescript
// ✅ CORRECT: Card operations
await cardRepository.create({
  name: "Charizard",
  set: "Base Set",
  price: 450.00
})

// ✅ CORRECT: Capture records
await db.query('INSERT INTO captures (filename, timestamp) VALUES ($1, $2)', 
  ['DSC00001.JPG', new Date()])

// ✅ CORRECT: OCR results
await db.query('UPDATE cards SET ocr_text = $1 WHERE id = $2',
  [ocrResult, cardId])
```

## ⚠️ Common Mistakes to Avoid

### ❌ WRONG: Mixing Databases
```typescript
// NEVER do this - storing production data in Archon
archon:store_card_data({ card: charizardData }) // ❌ WRONG!

// NEVER do this - storing docs in production
await db.query('INSERT INTO documentation ...') // ❌ WRONG!
```

### ❌ WRONG: Cross-Database Queries
```typescript
// Can't join across databases - they're completely separate
SELECT * FROM archon.knowledge k 
JOIN cardmint.cards c ON ... // ❌ IMPOSSIBLE!
```

## 🔧 Configuration Files

### Archon Configuration (`/home/profusionai/Archon/.env`):
```bash
SUPABASE_URL=https://rstdauvmrqmtuagkffgy.supabase.co
SUPABASE_SERVICE_KEY=<archon-specific-key>
# This is ONLY for Archon's knowledge management
```

### CardMint Configuration (`/home/profusionai/CardMint/.env`):
```bash
DATABASE_URL=postgresql://...@localhost:16380/pgdb-gjpkdon11dy0yln4
# This is ONLY for CardMint's production data
```

## 📊 Database Usage Patterns

### Archon Supabase Tables:
- `sources` - Crawled websites and uploaded documents
- `documents` - Document chunks with embeddings
- `projects` - Project management metadata
- `tasks` - Task tracking and status
- `code_examples` - Extracted code patterns

### CardMint Fly.io Tables:
- `cards` - Pokemon card inventory
- `captures` - Camera capture records
- `ocr_results` - OCR processing data
- `pricing` - Card pricing history
- `runs` - Processing run metadata

## 🚀 Best Practices

1. **Never Cross the Streams**: Keep knowledge and production data completely separate
2. **Use the Right Tool**: Archon for knowledge, CardMint DB for production
3. **Clear Naming**: Use descriptive variable names that indicate which system
4. **Environment Variables**: Keep connection strings clearly labeled
5. **Documentation**: Always specify which database in comments

## 🔍 Quick Reference

| Operation | Database | System | Port |
|-----------|----------|--------|------|
| Search documentation | Supabase | Archon | 8051 |
| Query code examples | Supabase | Archon | 8051 |
| Manage tasks | Supabase | Archon | 8051 |
| Store card data | PostgreSQL | Fly.io | 16380 |
| Save OCR results | PostgreSQL | Fly.io | 16380 |
| Track captures | PostgreSQL | Fly.io | 16380 |

## 🛡️ Security Considerations

- **Archon Supabase**: Public documentation, no sensitive card data
- **CardMint Fly.io**: Production data, requires proper authentication
- **Never store API keys or credentials in Archon's knowledge base**
- **Keep production connection strings out of documentation**

---

*This separation ensures clean architecture, prevents data mixing, and maintains security boundaries between knowledge management and production operations.*