import React from 'react';

/**
 * Fulfillment section in admin sidebar navigation
 * Injects into the EverShop admin navigation area
 */
export default function FulfillmentSidebarLink() {
  const isActive = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin/fulfillment');

  const linkStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 16px',
    color: isActive ? '#4ADC61' : '#6B7280',
    textDecoration: 'none',
    fontSize: '14px',
    fontWeight: isActive ? 500 : 400,
    borderRadius: '6px',
    backgroundColor: isActive ? 'rgba(74, 220, 97, 0.1)' : 'transparent',
    transition: 'all 0.2s ease',
  };

  const iconStyle = {
    width: '20px',
    height: '20px',
  };

  return (
    <div style={{ padding: '8px 12px' }}>
      <div style={{ fontSize: '11px', fontWeight: 600, color: '#9CA3AF', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '16px' }}>
        Fulfillment
      </div>
      <a href="/admin/fulfillment" style={linkStyle}>
        <svg style={iconStyle} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
        </svg>
        Shipping Dashboard
      </a>
    </div>
  );
}

export const layout = {
  areaId: 'adminNavigation',
  sortOrder: 70, // Before Analytics (80)
};
