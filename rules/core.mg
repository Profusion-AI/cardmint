// Core shared declarations
Decl card(Id, SetCode, Rarity, Lang, Number).
Decl ocr_field(Id, Field, Value, Conf).
Decl vendor_price(Sku, Vendor, Price, Ts).
Decl map_id_to_sku(Id, Sku).
Decl name_alias(A, B).
Decl img_phash(Id, Hash, Bucket).

// Alias symmetry and transitive closure
alias_sym(A,B) :- name_alias(A,B).
alias_sym(A,B) :- name_alias(B,A).

alias_tc(A,B)  :- alias_sym(A,B).
alias_tc(A,C)  :- alias_tc(A,B), alias_sym(B,C).

// Canonical name: lexicographic min per component
canon_name(C) :- alias_tc(C, _) |> do fn:group_by(), let C = fn:min(C).

// Duplicate predicate may be provided by EDB or computed service-side.
// If you want Mangle to derive it, provide an extensional predicate
// hamming_within(Ha, Hb, Thr) facts and use the rule below.
// dup(A,B) :- img_phash(A, Ha, Ba), img_phash(B, Hb, Ba), A < B, hamming_within(Ha, Hb, 5).
