package main

import (
    "encoding/json"
    "errors"
    "fmt"
    "log"
    "net/http"
    "sync/atomic"
    "time"
    "strings"
)

type Fact struct {
    Pred string        `json:"pred"`
    Args []interface{} `json:"args"`
}

type LoadFactsRequest struct {
    Facts       []Fact `json:"facts"`
    RulesetHash string `json:"ruleset_hash"`
}

type QueryRequest struct {
    Predicate string        `json:"predicate"`
    Args      []interface{} `json:"args"`
    Explain   bool          `json:"explain"`
    Limit     int           `json:"limit"`
}

type Row = []interface{}

type QueryResponse struct {
    Rows       []Row        `json:"rows"`
    Derivation []Derivation `json:"derivation,omitempty"`
}

type Derivation struct {
    RuleID string `json:"rule_id"`
    Inputs []Fact `json:"inputs"`
}

var svc *RulesService

func SetupRouter(cfg Config) http.Handler {
    svc = NewRulesService(cfg)
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]any{
            "status": "ok",
            "config": cfg,
            "ruleset_hash": svc.rulesHash,
        })
    })
    mux.HandleFunc("/metrics", handleMetrics)
    mux.HandleFunc("/facts:load", handleLoadFacts)
    mux.HandleFunc("/query", handleQuery)
    return mux
}

func handleLoadFacts(w http.ResponseWriter, r *http.Request) {
    var req LoadFactsRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    start := time.Now()
    if err := svc.LoadRulesIfNeeded(); err != nil {
        http.Error(w, fmt.Sprintf("rules error: %v", err), http.StatusBadRequest)
        return
    }
    if err := svc.LoadFacts(req.Facts); err != nil {
        var bad *ErrBadFact
        if errors.As(err, &bad) {
            http.Error(w, bad.Error(), http.StatusBadRequest)
            return
        }
        http.Error(w, err.Error(), http.StatusInternalServerError)
        return
    }
    ms := time.Since(start).Milliseconds()
    atomic.AddInt64(&metricsFactsLoadCount, 1)
    metricsLastFactsLoadMS = int(ms)
    log.Printf("facts_load predicate=all facts=%d ms=%d ruleset_hash=%s", len(req.Facts), ms, svc.rulesHash)
    w.WriteHeader(http.StatusNoContent)
}

func handleQuery(w http.ResponseWriter, r *http.Request) {
    var req QueryRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }
    start := time.Now()
    rows, deriv, err := svc.Query(req)
    if err != nil {
        code := http.StatusBadRequest
        if strings.HasPrefix(err.Error(), "invalid_arg") || strings.HasPrefix(err.Error(), "wrong_arity") {
            code = http.StatusUnprocessableEntity
        }
        http.Error(w, err.Error(), code)
        return
    }
    resp := QueryResponse{Rows: rows}
    if req.Explain {
        resp.Derivation = deriv
    }
    w.Header().Set("Content-Type", "application/json")
    if err := json.NewEncoder(w).Encode(resp); err != nil {
        log.Printf("encode resp: %v", err)
    }
    ms := time.Since(start).Milliseconds()
    atomic.AddInt64(&metricsQueryCount, 1)
    metricsLastQueryMS = int(ms)
    log.Printf("query predicate=%s args=%v rows=%d explain=%v ms=%d facts=%d", req.Predicate, req.Args, len(rows), req.Explain, ms, svc.store.EstimateFactCount())
}

var (
    metricsQueryCount     int64
    metricsFactsLoadCount int64
    metricsLastQueryMS    int
    metricsLastFactsLoadMS int
)

func handleMetrics(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{
        "queries_total": atomic.LoadInt64(&metricsQueryCount),
        "facts_load_total": atomic.LoadInt64(&metricsFactsLoadCount),
        "last_query_ms": metricsLastQueryMS,
        "last_facts_load_ms": metricsLastFactsLoadMS,
    })
}
