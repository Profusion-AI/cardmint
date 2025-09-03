Perform a security-focused PR review.

Output a single PR comment with:
- Findings grouped by category: Input Validation, Auth/Z, Secrets, Deserialization, SSRF/Path traversal, Supply-chain, Serialization, Command Injection.
- Severity tags: High/Med/Low, with CWE where applicable.
- Proof-of-concept snippets or concrete diff suggestions.
- “What to monitor post-merge”.
