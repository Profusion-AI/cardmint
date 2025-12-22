import { addProcessor } from "@evershop/evershop/lib/util/registry";

export default function bootstrap() {
  console.log("[cardmint_admin_theme] Bootstrap loading...");

  // Sort processors for cm_* columns
  addProcessor("productCollectionSortBy", (sortBy) => {
    return {
      ...sortBy,
      cm_set_name: (query) => query.orderBy("product.cm_set_name", "ASC"),
      cm_variant: (query) => query.orderBy("product.cm_variant", "ASC"),
      cm_market_price: (query) => query.orderBy("product.cm_market_price", "ASC"),
      cm_pricing_updated_at: (query) =>
        query.orderBy("product.cm_pricing_updated_at", "ASC"),
    };
  });

  // Note: cm_* columns are already fetched by getProductsBaseQuery()'s implicit SELECT *
  // No need to modify the query - GraphQL resolvers handle the field mapping
}
