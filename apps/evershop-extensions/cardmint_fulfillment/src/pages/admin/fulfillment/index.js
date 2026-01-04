import { setContextValue } from "@evershop/evershop/graphql/services/contextHelper.js";

export default function(request, response, next) {
  setContextValue(request, "pageInfo", {
    title: "Fulfillment Dashboard",
    description: "CardMint unified shipping and fulfillment management",
  });
  next();
}
