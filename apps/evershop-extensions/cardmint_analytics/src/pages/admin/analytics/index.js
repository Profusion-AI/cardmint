import { setContextValue } from "@evershop/evershop/graphql/services";

export default function(request, response, next) {
  setContextValue(request, "pageInfo", {
    title: "Analytics Dashboard",
    description: "CardMint conversion funnel and metrics",
  });
  next();
}
