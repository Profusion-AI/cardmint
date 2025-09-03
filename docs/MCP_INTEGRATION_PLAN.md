# MCP Integration Plan (Corrected)

Purpose: integrate persistent memory for GPT‑OSS‑20B via In Memoria MCP, while keeping CardMint’s DB/Resolver tools in‑process for sub‑ms performance. Archon MCP remains a Claude Code CLI tool only (developer RAG), not part of the end‑user runtime.

## Components

- In Memoria MCP (runtime memory)
  - Server: `npx in-memoria server`
  - Tools: pattern recommendations, semantic insights, contribute insights.
  - Adapter: `src/mcp/InMemoriaClient.ts` + `src/gpt/MemoryAdapter.ts`.

- CardMint tools (in‑process, read‑only)
  - catalog.resolveExact (DeterministicResolver)
  - catalog.ftsSearch (FTS5)
  - inventory.checkOwnership (inventory_items)
  - prices.getLatest (latest_market_prices)
  - ocr.retry (OCR service wrapper)
  - tcg.lookup (PokemonTCGService)

- Archon MCP (developer only)
  - Used via Claude Code CLI for docs/RAG/tasks/code examples.
  - Not invoked by GPT‑OSS‑20B in user workflows.

## Flow

1) Agent attempts deterministic resolution using in‑process tools.
2) If ambiguous, call MemoryAdapter.fetchPatterns(context) to bias decisions.
3) After a final decision, call MemoryAdapter.contributeInsights(compact evidence):
   - OCR error classes and chosen corrections
   - Alias/normalization hints that improved matching
   - Price basis selection logic in edge cases

## Env/Config

- `MEMORIA_ENABLED=true|false`
- `MEMORIA_ENDPOINT` (optional, local default)

## Files

- `src/mcp/InMemoriaClient.ts`: thin MCP adapter (scaffold; no transport lock‑in)
- `src/gpt/MemoryAdapter.ts`: InMemoriaMemoryAdapter with ensureReady/fetchPatterns/contributeInsights

## Rationale

- Performance: DB/Resolver remain in‑process; no MCP overhead in hot path.
- Separation: Developer RAG (Archon) vs runtime memory (In Memoria).
- Safety: Memory is optional; agent continues seamlessly if disabled/unavailable.

