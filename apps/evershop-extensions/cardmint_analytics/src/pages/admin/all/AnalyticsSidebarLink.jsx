import React from 'react';

/**
 * Analytics section in admin sidebar navigation
 * Injects into the EverShop admin navigation area
 */
export default function AnalyticsSidebarLink() {
  const isActive = typeof window !== 'undefined' && window.location.pathname.startsWith('/admin/analytics');

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
        Analytics
      </div>
      <a href="/admin/analytics" style={linkStyle}>
        <svg style={iconStyle} fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
        Conversion Funnel
      </a>
    </div>
  );
}

export const layout = {
  areaId: 'adminNavigation',
  sortOrder: 80, // After main navigation items, before settings
};
