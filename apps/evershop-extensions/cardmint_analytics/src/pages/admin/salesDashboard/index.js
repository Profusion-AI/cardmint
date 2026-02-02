import { setContextValue } from "@evershop/evershop/graphql/services";

export default function(request, response, next) {
  setContextValue(request, "pageInfo", {
    title: "CM Sales Dash",
    description: "CardMint sales performance and forecasting",
  });
  next();
}
