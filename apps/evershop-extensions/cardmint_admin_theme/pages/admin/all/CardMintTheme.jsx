import React from 'react';
import './CardMintTheme.scss';

/**
 * CardMint Admin Theme Component
 *
 * This component injects the CardMint brand styling into the EverShop admin panel.
 * It overrides the default CSS variables with CardMint's brand palette:
 * - Midnight Blue (#0A203F) - primary dark background
 * - CardMint Green (#4ADC61) - primary actions and accents
 * - Gold (#D4AF37) - premium/warning indicators
 * - Sage (#98B2A6) - secondary elements and borders
 */
export default function CardMintTheme() {
  return null; // Pure CSS injection, no visible component
}

export const layout = {
  areaId: 'body',
  sortOrder: 1 // Load before other components to ensure CSS priority
};
