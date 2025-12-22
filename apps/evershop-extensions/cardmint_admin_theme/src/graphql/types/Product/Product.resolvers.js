/**
 * CardMint Product Admin Resolvers
 *
 * Resolves CardMint-specific fields for admin product grid.
 * NOTE: EverShop's camelCase() transforms DB rows before resolvers receive them.
 *       Database: cm_set_name → Resolver receives: cmSetName
 */
export default {
  Product: {
    cmSetName: (product) => product.cmSetName ?? null,
    cmVariant: (product) => product.cmVariant ?? null,
    cmMarketPrice: (product) => {
      const price = product.cmMarketPrice;
      return price != null ? parseFloat(price) : null;
    },
    cmPricingSource: (product) => product.cmPricingSource ?? null,
    cmPricingStatus: (product) => product.cmPricingStatus ?? null,
    cmPricingUpdatedAt: (product) => {
      const updatedAt = product.cmPricingUpdatedAt;
      return updatedAt ? updatedAt.toISOString?.() ?? String(updatedAt) : null;
    },
    cmProductUid: (product) => product.cmProductUid ?? null,
    cmInventoryStatus: (product) => product.cmInventoryStatus ?? null,
  }
};
