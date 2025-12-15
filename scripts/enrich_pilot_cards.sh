#!/bin/bash
# Enrich the 22 pilot cards (6 products) with PPT pricing

PRODUCTS=(
  "d151505d-1d71-45e8-9f23-fa6f7e04ce13"  # 11× Vulpix EVO
  "058f0629-3443-4c9e-a34b-63a856a5789e"  # 6× Pikachu Base
  "e7dbcca7-6198-43fa-8d97-c860ddc9acef"  # 2× Vulpix Base
  "ed3ab7f3-40cd-49b1-9bda-4b957490c635"  # 1× Vulpix Topps TV
  "6839b157-58b2-43aa-b7e1-8602e0fd5055"  # 1× Vulpix Aquapolis
  "b605d393-52c4-4c15-b749-302be77596ab"  # 1× Pikachu EVO
)

echo "Enriching 6 products (22 physical cards)..."
echo ""

for uid in "${PRODUCTS[@]}"; do
  echo "Enriching product: $uid"
  curl -sS -X POST http://127.0.0.1:4000/api/operator/enrich/ppt \
    -H "Content-Type: application/json" \
    -d "{\"product_uid\":\"$uid\"}" | jq -c '{success, market_price: .priceData.market_price, parse_title: .parse_title_request}'
  echo ""
  sleep 1
done

echo "✅ Enrichment complete"
