// Confidence-gated validation (non-recursive, no negation)
valid_card(Id) :-
  ocr_field(Id, "title", _, C1), C1 > 0.93,
  ocr_field(Id, "set",   _, C2), C2 > 0.90.
