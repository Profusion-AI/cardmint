// Freshness window predicate provided via facts or service-side windowing
Decl fresh(Ts).

// Weighted vendor arbitration
candidate_price(Id, V, P) :-
  map_id_to_sku(Id, S),
  vendor_price(S, V, P, Ts),
  fresh(Ts).

// weight(Vendor, W) is a facts table.
Decl weight(Vendor, W).

price_for(Id, "weighted", P) :-
  candidate_price(Id, V, Pv),
  weight(V, W)
    |> do fn:group_by(Id),
       let P = fn:div(fn:sum(fn:mult(W, Pv)), fn:sum(W)).
