import { setContextValue } from "@evershop/evershop/graphql/services";

export default function(request, response, next) {
  setContextValue(request, "pageInfo", {
    title: "Search Dashboard",
    description: "CardMint search app monitoring and testing",
  });
  next();
}
