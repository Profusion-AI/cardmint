package main

import (
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "os"
    "path/filepath"
    "sort"
    "strconv"
    "strings"
)

type Config struct {
    Addr              string
    RulesDir          string
    WindowMaxFacts    int
    PhashHammingMax   int
    FreshDays         int
    OCRTitleMin       float64
    OCRSetMin         float64
}

func loadConfig() (Config, error) {
    c := Config{
        Addr:            getEnv("MANGLE_SERVICE_ADDR", ":8089"),
        RulesDir:        getEnv("MANGLE_RULES_DIR", filepath.Join("..", "rules")),
        WindowMaxFacts:  getEnvInt("WINDOW_MAX_FACTS", 20000),
        PhashHammingMax: getEnvInt("PHASH_HAMMING_MAX", 5),
        FreshDays:       getEnvInt("FRESH_DAYS", 7),
        OCRTitleMin:     getEnvFloat("OCR_TITLE_MIN", 0.93),
        OCRSetMin:       getEnvFloat("OCR_SET_MIN", 0.90),
    }
    // Fail fast on nonsensical bounds
    if c.PhashHammingMax < 0 || c.PhashHammingMax > 64 {
        return c, fmt.Errorf("PHASH_HAMMING_MAX must be 0..64")
    }
    if c.FreshDays < 0 || c.FreshDays > 3650 {
        return c, fmt.Errorf("FRESH_DAYS out of range")
    }
    if c.OCRTitleMin < 0 || c.OCRTitleMin > 1 || c.OCRSetMin < 0 || c.OCRSetMin > 1 {
        return c, fmt.Errorf("OCR_*_MIN must be in [0,1]")
    }
    return c, nil
}

func getEnv(key, def string) string {
    if v := os.Getenv(key); v != "" { return v }
    return def
}
func getEnvInt(key string, def int) int {
    if v := os.Getenv(key); v != "" {
        n, err := strconv.Atoi(v)
        if err != nil { panic(fmt.Errorf("invalid %s: %v", key, err)) }
        return n
    }
    return def
}
func getEnvFloat(key string, def float64) float64 {
    if v := os.Getenv(key); v != "" {
        f, err := strconv.ParseFloat(v, 64)
        if err != nil { panic(fmt.Errorf("invalid %s: %v", key, err)) }
        return f
    }
    return def
}

// rulesDirHash computes SHA-256 of sorted filenames + contents (concatenated).
func rulesDirHash(dir string) (string, error) {
    entries, err := os.ReadDir(dir)
    if err != nil { return "", err }
    var names []string
    for _, e := range entries {
        if e.IsDir() || !strings.HasSuffix(e.Name(), ".mg") { continue }
        names = append(names, e.Name())
    }
    sort.Strings(names)
    h := sha256.New()
    for _, name := range names {
        h.Write([]byte(name))
        b, err := os.ReadFile(filepath.Join(dir, name))
        if err != nil { return "", err }
        h.Write(b)
    }
    return hex.EncodeToString(h.Sum(nil)), nil
}

