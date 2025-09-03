package main

import (
    "log"
    "net/http"
    "os"
)

func main() {
    if os.Getenv("CARDMINT_RULES_BRAIN_ENABLED") != "1" {
        log.Println("Rules Brain disabled; exiting early")
        return
    }
    cfg, err := loadConfig()
    if err != nil {
        log.Fatalf("invalid config: %v", err)
    }
    r := SetupRouter(cfg)
    log.Printf("mangle-service listening on %s", cfg.Addr)
    if err := http.ListenAndServe(cfg.Addr, r); err != nil {
        log.Fatal(err)
    }
}
