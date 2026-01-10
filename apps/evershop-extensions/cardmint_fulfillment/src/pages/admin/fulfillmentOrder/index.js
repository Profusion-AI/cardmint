import { setContextValue } from "@evershop/evershop/graphql/services";

export default function orderDetailsPage(request, response, next) {
  setContextValue(request, "pageInfo", {
    title: "Order Details",
    description: "CardMint fulfillment order drill-in view",
  });
  next();
}

