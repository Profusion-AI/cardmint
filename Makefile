dev:
	- cd service && go get github.com/google/mangle@latest && go mod tidy
	CARDMINT_RULES_BRAIN_ENABLED=1 go run ./service

lint:
	- go vet ./service/...
	- golangci-lint run ./service/... || true

check-rules:
	CARDMINT_RULES_BRAIN_ENABLED=1 node scripts/check-rules.js

test: lint check-rules
	# Snapshot tests on goldens
	CARDMINT_RULES_BRAIN_ENABLED=1 node scripts/test-snapshots.js
