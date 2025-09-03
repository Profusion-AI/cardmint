package main

import (
    "errors"
    "fmt"
    "os"
    "path/filepath"
    "sort"
    "strings"
    "sync"

    "github.com/google/mangle/analysis"
    "github.com/google/mangle/ast"
    "github.com/google/mangle/engine"
    "github.com/google/mangle/factstore"
    "github.com/google/mangle/parse"
)

type RulesService struct {
    mu           sync.RWMutex
    rulesHash    string
    rulesDir     string
    program      *analysis.ProgramInfo
    strata       []analysis.Nodeset
    predToStrata map[ast.PredicateSym]int
    predToRules  map[ast.PredicateSym][]ast.Clause
    predToDecl   map[ast.PredicateSym]*ast.Decl
    store        factstore.FactStoreWithRemove
    cfg          Config
}

func NewRulesService(cfg Config) *RulesService {
    dir := cfg.RulesDir
    return &RulesService{rulesDir: dir, cfg: cfg}
}

// ErrBadFact indicates caller supplied invalid fact payload.
type ErrBadFact struct{ msg string }
func (e *ErrBadFact) Error() string { return e.msg }

func (r *RulesService) LoadRulesIfNeeded() error {
    r.mu.Lock()
    defer r.mu.Unlock()
    // Compute deterministic hash of rules dir
    currentHash, err := rulesDirHash(r.rulesDir)
    if err != nil { return err }
    if r.program != nil && r.rulesHash == currentHash { return nil }
    // Parse all .mg files in rulesDir
    entries, err := os.ReadDir(r.rulesDir)
    if err != nil {
        return fmt.Errorf("read rules dir: %w", err)
    }
    var units []parse.SourceUnit
    for _, e := range entries {
        if e.IsDir() || !strings.HasSuffix(e.Name(), ".mg") {
            continue
        }
        b, err := os.ReadFile(filepath.Join(r.rulesDir, e.Name()))
        if err != nil {
            return fmt.Errorf("read %s: %w", e.Name(), err)
        }
        unit, err := parse.Unit(strings.NewReader(string(b)))
        if err != nil {
            return fmt.Errorf("parse %s: %w", e.Name(), err)
        }
        units = append(units, unit)
    }
    if len(units) == 0 {
        return fmt.Errorf("no rule files found in %s", r.rulesDir)
    }
    prog, err := analysis.AnalyzeAndCheckBounds(units, nil, analysis.ErrorForBoundsMismatch)
    if err != nil {
        return fmt.Errorf("analyze: %w", err)
    }
    // Stratification guardrails: no recursion-through-negation or through do-transform.
    strata, predToStratum, err := analysis.Stratify(analysis.Program{
        EdbPredicates: prog.EdbPredicates,
        IdbPredicates: prog.IdbPredicates,
        Rules:         prog.Rules,
    })
    if err != nil {
        return fmt.Errorf("stratification: %w", err)
    }
    // Build rule and decl maps
    predToRules := make(map[ast.PredicateSym][]ast.Clause)
    predToDecl := make(map[ast.PredicateSym]*ast.Decl)
    for _, clause := range prog.Rules {
        sym := clause.Head.Predicate
        predToRules[sym] = append(predToRules[sym], clause)
        predToDecl[sym] = prog.Decls[sym]
    }
    r.program = prog
    r.strata = strata
    r.predToStrata = predToStratum
    r.predToRules = predToRules
    r.predToDecl = predToDecl
    r.rulesHash = currentHash
    // Fresh store on rules reload
    r.store = factstore.NewSimpleInMemoryStore()
    return nil
}

func (r *RulesService) LoadFacts(facts []Fact) error {
    if r.program == nil {
        return errors.New("rules not loaded")
    }
    // Enforce window cap
    if r.cfg.WindowMaxFacts > 0 && len(facts) > r.cfg.WindowMaxFacts {
        return &ErrBadFact{fmt.Sprintf("window_max_exceeded: %d > %d", len(facts), r.cfg.WindowMaxFacts)}
    }
    // Reset store and (re)load facts
    r.store = factstore.NewSimpleInMemoryStore()
    // First pass: ingest caller facts
    for i, f := range facts {
        if f.Pred == "" {
            return &ErrBadFact{fmt.Sprintf("fact[%d]: missing pred", i)}
        }
        atom, err := jsonFactToAtom(f)
        if err != nil {
            return &ErrBadFact{fmt.Sprintf("fact[%d]: %v", i, err)}
        }
        r.store.Add(atom)
    }
    // Optional service-side augmentation: compute dup(A,B) from img_phash by bucket and hamming distance.
    augmentDuplicates(r.store, r.cfg.PhashHammingMax)
    // Optionally derive fresh(Ts) from vendor_price timestamps if no fresh facts given
    ensureFreshFacts(r.store, r.cfg.FreshDays)
    // Evaluate program
    _, err := engine.EvalStratifiedProgramWithStats(r.program, r.strata, r.predToStrata, r.store)
    if err != nil {
        return fmt.Errorf("eval: %w", err)
    }
    return nil
}

func (r *RulesService) Query(q QueryRequest) ([]Row, []Derivation, error) {
    r.mu.RLock()
    defer r.mu.RUnlock()
    if r.program == nil {
        return nil, nil, errors.New("rules not loaded")
    }
    // Determine arity from decls if available
    // whitelist allowed predicates
    allowed := map[string]int{"valid_card":1, "duplicate_of":2, "price_for":3}
    var arity int
    var predSym ast.PredicateSym
    if v, ok := allowed[q.Predicate]; ok {
        arity = v
        predSym = ast.PredicateSym{Symbol: q.Predicate, Arity: arity}
    } else {
        return nil, nil, fmt.Errorf("predicate_not_allowed")
    }
    if len(q.Args) != 0 && len(q.Args) != arity {
        return nil, nil, fmt.Errorf("wrong_arity: got %d want %d", len(q.Args), arity)
    }
    // basic arg validation
    if err := validateArgs(q); err != nil {
        return nil, nil, err
    }
    // Build result rows by scanning facts
    var rows []Row
    err := r.store.GetFacts(ast.NewQuery(predSym), func(a ast.Atom) error {
        // Optionally filter by provided constants
        if len(q.Args) > 0 {
            if !matchArgs(q.Args, a.Args) {
                return nil
            }
        }
        rows = append(rows, atomToRow(a))
        if q.Limit > 0 && len(rows) >= q.Limit {
            return fmt.Errorf("limit")
        }
        return nil
    })
    if err != nil && err.Error() != "limit" {
        return nil, nil, err
    }
    var deriv []Derivation
    if q.Explain {
        // Minimal provenance: rule head symbol and coarse input facts for known patterns
        for _, row := range rows {
            d := Derivation{RuleID: q.Predicate, Inputs: r.deriveInputs(q.Predicate, row)}
            deriv = append(deriv, d)
        }
    }
    return rows, deriv, nil
}

// deriveInputs returns coarse input facts for our v0 rules.
func (r *RulesService) deriveInputs(predicate string, row Row) []Fact {
    switch predicate {
    case "valid_card":
        // row: [Id]
        id := row[0]
        var inputs []Fact
        // two ocr_field facts
        r.store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "ocr_field", Arity: 4}), func(a ast.Atom) error {
            if a.Args[0].String() == fmt.Sprint(id) {
                f := atomToFact(a)
                if len(f.Args) >= 2 && (f.Args[1] == "title" || f.Args[1] == "set") {
                    inputs = append(inputs, f)
                }
            }
            return nil
        })
        return inputs
    case "duplicate_of":
        a := row[0]
        b := row[1]
        // dup(A,B) fact (service computed)
        var inputs []Fact
        r.store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "dup", Arity: 2}), func(at ast.Atom) error {
            if at.Args[0].String() == fmt.Sprint(a) && at.Args[1].String() == fmt.Sprint(b) {
                inputs = append(inputs, atomToFact(at))
            }
            return nil
        })
        return inputs
    case "price_for":
        // row: [Id, Strategy, Price]
        id := row[0]
        var inputs []Fact
        // gather map_id_to_sku(Id,S)
        var sku string
        r.store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "map_id_to_sku", Arity: 2}), func(a ast.Atom) error {
            if a.Args[0].String() == fmt.Sprint(id) {
                inputs = append(inputs, atomToFact(a))
                sku = a.Args[1].String()
            }
            return nil
        })
        if sku != "" {
            // vendor_price(S,...)
            r.store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "vendor_price", Arity: 4}), func(a ast.Atom) error {
                if a.Args[0].String() == sku {
                    inputs = append(inputs, atomToFact(a))
                }
                return nil
            })
        }
        // fresh(_)
        r.store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "fresh", Arity: 1}), func(a ast.Atom) error {
            inputs = append(inputs, atomToFact(a))
            return nil
        })
        return inputs
    default:
        return nil
    }
}

// jsonFactToAtom converts external fact to mangle atom.
func jsonFactToAtom(f Fact) (ast.Atom, error) {
    var args []ast.BaseTerm
    for _, v := range f.Args {
        bt, err := toBaseTerm(v)
        if err != nil {
            return ast.Atom{}, err
        }
        args = append(args, bt)
    }
    return ast.Atom{Predicate: ast.PredicateSym{Symbol: f.Pred, Arity: len(args)}, Args: args}, nil
}

func toBaseTerm(v interface{}) (ast.BaseTerm, error) {
    switch t := v.(type) {
    case float64:
        // Treat integers specially
        if t == float64(int64(t)) {
            return ast.Number(int64(t)), nil
        }
        return ast.Float64(t), nil
    case string:
        return ast.String(t), nil
    case bool:
        if t {
            return ast.TrueConstant, nil
        }
        return ast.FalseConstant, nil
    default:
        return nil, fmt.Errorf("unsupported value %v (%T)", v, v)
    }
}

func atomToRow(a ast.Atom) Row {
    row := make([]interface{}, len(a.Args))
    for i, arg := range a.Args {
        row[i] = arg.String()
    }
    return row
}

func atomToFact(a ast.Atom) Fact {
    row := make([]interface{}, len(a.Args))
    for i, arg := range a.Args {
        row[i] = arg.String()
    }
    return Fact{Pred: a.Predicate.Symbol, Args: row}
}

func matchArgs(filter []interface{}, args []ast.BaseTerm) bool {
    if len(filter) == 0 { return true }
    for i := range filter {
        if i >= len(args) { return false }
        if fmt.Sprint(filter[i]) != args[i].String() { return false }
    }
    return true
}

// augmentDuplicates computes dup(A,B) facts from img_phash facts by bucket and Hamming distance within 5 bits.
func augmentDuplicates(store factstore.FactStore, hammingMax int) {
    // Gather img_phash by bucket
    type entry struct{ id string; hash uint64; bucket string }
    var entries []entry
    _ = store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "img_phash", Arity: 3}), func(a ast.Atom) error {
        id := a.Args[0].String()
        hb := a.Args[1].String()
        var h uint64
        // allow hex or decimal
        if strings.HasPrefix(hb, "0x") || strings.HasPrefix(hb, "0X") {
            fmt.Sscanf(hb, "%x", &h)
        } else {
            fmt.Sscanf(hb, "%d", &h)
        }
        entries = append(entries, entry{id: id, hash: h, bucket: a.Args[2].String()})
        return nil
    })
    // group by bucket
    byBucket := map[string][]entry{}
    for _, e := range entries {
        byBucket[e.bucket] = append(byBucket[e.bucket], e)
    }
    // compare within bucket
    for _, list := range byBucket {
        // sort by id to canonicalize A<B
        sort.Slice(list, func(i, j int) bool { return list[i].id < list[j].id })
        for i := 0; i < len(list); i++ {
            for j := i + 1; j < len(list); j++ {
                if popcnt(list[i].hash^list[j].hash) <= hammingMax {
                    store.Add(ast.Atom{Predicate: ast.PredicateSym{Symbol: "dup", Arity: 2}, Args: []ast.BaseTerm{ast.String(list[i].id), ast.String(list[j].id)}})
                }
            }
        }
    }
    // duplicate_of derived trivially from dup; optional here as EDB to simplify
    _ = store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "dup", Arity: 2}), func(a ast.Atom) error {
        store.Add(ast.Atom{Predicate: ast.PredicateSym{Symbol: "duplicate_of", Arity: 2}, Args: a.Args})
        return nil
    })
}

// ensureFreshFacts injects fresh(Ts) based on vendor_price timestamps if missing.
func ensureFreshFacts(store factstore.FactStore, days int) {
    if days <= 0 { return }
    hasFresh := false
    _ = store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "fresh", Arity: 1}), func(a ast.Atom) error {
        hasFresh = true
        return nil
    })
    if hasFresh { return }
    // find max ts
    var maxTs int64
    _ = store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "vendor_price", Arity: 4}), func(a ast.Atom) error {
        if len(a.Args) >= 4 {
            val, _ := a.Args[3].(ast.Constant).NumberValue()
            if val > maxTs { maxTs = val }
        }
        return nil
    })
    if maxTs == 0 { return }
    cutoff := maxTs - int64(days)*86400
    _ = store.GetFacts(ast.NewQuery(ast.PredicateSym{Symbol: "vendor_price", Arity: 4}), func(a ast.Atom) error {
        if len(a.Args) >= 4 {
            val, _ := a.Args[3].(ast.Constant).NumberValue()
            if val >= cutoff {
                store.Add(ast.Atom{Predicate: ast.PredicateSym{Symbol: "fresh", Arity: 1}, Args: []ast.BaseTerm{a.Args[3]}})
            }
        }
        return nil
    })
}

func validateArgs(q QueryRequest) error {
    switch q.Predicate {
    case "valid_card":
        if len(q.Args) == 0 { return nil }
        if len(q.Args) != 1 { return fmt.Errorf("wrong_arity") }
        if _, ok := q.Args[0].(string); !ok { return fmt.Errorf("invalid_arg: id must be string") }
    case "duplicate_of":
        if len(q.Args) == 0 { return nil }
        if len(q.Args) != 2 { return fmt.Errorf("wrong_arity") }
        if _, ok := q.Args[0].(string); !ok { return fmt.Errorf("invalid_arg: id must be string") }
        if _, ok := q.Args[1].(string); !ok { return fmt.Errorf("invalid_arg: id must be string") }
    case "price_for":
        if len(q.Args) == 0 { return nil }
        if len(q.Args) != 3 { return fmt.Errorf("wrong_arity") }
        if _, ok := q.Args[0].(string); !ok { return fmt.Errorf("invalid_arg: id must be string") }
        if s, ok := q.Args[1].(string); !ok || s != "weighted" { return fmt.Errorf("invalid_arg: strategy must be 'weighted'") }
        // third may be wildcard placeholder, ignore type
    }
    return nil
}

func popcnt(x uint64) int {
    // Kernighan's method
    c := 0
    for x != 0 {
        x &= x - 1
        c++
    }
    return c
}
