# Glossary

- EDB: Extensional Database (input facts).
- IDB: Intensional Database (derived facts).
- Stratification: Layering of rules so recursion and negation are safe.
- Provenance: Why a fact holds (rule and inputs).
- Transform: Mangle pipeline for grouping and reducers (e.g., `|> do fn:group_by()` then `let` statements like `let P = fn:sum(...)`).

