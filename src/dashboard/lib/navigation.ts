// src/dashboard/lib/navigation.ts
// Unified navigation component for all dashboards

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    href: '/dashboard/',
    label: 'Dashboard Hub',
    icon: '🏠',
    description: 'Main navigation and system overview'
  },
  {
    href: '/processing-status.html',
    label: 'Processing Status',
    icon: '📊',
    description: 'Real-time processing pipeline monitoring'
  },
  {
    href: '/dashboard/performance.html',
    label: 'Performance Monitor',
    icon: '⚡',
    description: 'System performance metrics and SLA tracking'
  },
  {
    href: '/dashboard/verification.html',
    label: 'Card Verification',
    icon: '✅',
    description: 'Review and validate processed cards'
  },
  {
    href: '/dashboard/ensemble-dashboard.html',
    label: 'Batch Results',
    icon: '📦',
    description: 'Ensemble processing results and exports'
  },
  {
    href: '/dashboard/health.html',
    label: 'System Health',
    icon: '🏥',
    description: 'System monitoring and diagnostics'
  }
];

export function createNavigationHeader(currentPath: string = ''): string {
  const currentItem = NAV_ITEMS.find(item => 
    currentPath === item.href || 
    (currentPath === '/dashboard' && item.href === '/dashboard/') ||
    currentPath.endsWith(item.href.split('/').pop() || '')
  );

  const breadcrumbs = currentItem ? [
    { href: '/dashboard/', label: 'Dashboard' },
    { href: currentItem.href, label: currentItem.label }
  ] : [{ href: '/dashboard/', label: 'Dashboard' }];

  return `
    <nav class="dashboard-nav" id="dashboard-nav">
      <div class="nav-container">
        <div class="nav-brand">
          <a href="/dashboard/" class="brand-link">
            <span class="brand-icon">🃏</span>
            <span class="brand-text">CardMint</span>
            <span class="brand-subtitle">v2.0</span>
          </a>
        </div>
        
        <div class="nav-breadcrumbs">
          ${breadcrumbs.map((crumb, index) => `
            <a href="${crumb.href}" class="breadcrumb ${index === breadcrumbs.length - 1 ? 'active' : ''}">
              ${crumb.label}
            </a>
            ${index < breadcrumbs.length - 1 ? '<span class="separator">›</span>' : ''}
          `).join('')}
        </div>
        
        <div class="nav-actions">
          <div class="nav-dropdown" id="nav-dropdown">
            <button class="nav-dropdown-toggle" id="nav-dropdown-toggle" aria-expanded="false" aria-haspopup="true" aria-controls="nav-dropdown-menu">
              <span class="current-page">${currentItem?.icon || '🏠'} ${currentItem?.label || 'Dashboard'}</span>
              <span class="dropdown-arrow">▾</span>
            </button>
            <div class="nav-dropdown-menu" id="nav-dropdown-menu" role="menu" aria-labelledby="nav-dropdown-toggle">
              ${NAV_ITEMS.map(item => `
                <a href="${item.href}" class="nav-dropdown-item ${currentPath.includes(item.href) ? 'active' : ''}" role="menuitem" tabindex="-1">
                  <span class="item-icon">${item.icon}</span>
                  <div class="item-content">
                    <div class="item-label">${item.label}</div>
                    <div class="item-description">${item.description}</div>
                  </div>
                </a>
              `).join('')}
            </div>
          </div>
          
          <div class="nav-status" id="nav-status">
            <div class="status-indicator" id="system-status" aria-live="polite">
              <span class="status-dot offline"></span>
              <span class="status-text">Connecting...</span>
            </div>
          </div>
        </div>
      </div>
    </nav>
  `;
}

export function createNavigationStyles(): string {
  return `
    <style>
      .dashboard-nav {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: rgba(255, 255, 255, 0.95);
        backdrop-filter: blur(10px);
        border-bottom: 1px solid rgba(0, 0, 0, 0.1);
        z-index: 1000;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
      }
      
      .nav-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        max-width: 1400px;
        margin: 0 auto;
        padding: 12px 24px;
        gap: 20px;
      }
      
      .nav-brand {
        flex-shrink: 0;
      }
      
      .brand-link {
        display: flex;
        align-items: center;
        gap: 8px;
        text-decoration: none;
        color: #2d3748;
        font-weight: 600;
        transition: color 0.2s;
      }
      
      .brand-link:hover {
        color: #667eea;
      }
      
      .brand-icon {
        font-size: 1.5rem;
      }
      
      .brand-text {
        font-size: 1.2rem;
        font-weight: 700;
      }
      
      .brand-subtitle {
        font-size: 0.8rem;
        color: #718096;
        background: #e2e8f0;
        padding: 2px 6px;
        border-radius: 4px;
        font-weight: 500;
      }
      
      .nav-breadcrumbs {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 0.9rem;
        color: #718096;
      }
      
      .breadcrumb {
        text-decoration: none;
        color: #718096;
        padding: 4px 8px;
        border-radius: 4px;
        transition: all 0.2s;
      }
      
      .breadcrumb:hover {
        background: #f7fafc;
        color: #2d3748;
      }
      
      .breadcrumb.active {
        color: #667eea;
        font-weight: 600;
      }
      
      .separator {
        color: #cbd5e0;
        user-select: none;
      }
      
      .nav-actions {
        display: flex;
        align-items: center;
        gap: 16px;
        flex-shrink: 0;
      }
      
      .nav-dropdown {
        position: relative;
      }
      
      .nav-dropdown-toggle {
        display: flex;
        align-items: center;
        gap: 8px;
        background: #f7fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        padding: 8px 12px;
        font-size: 0.9rem;
        cursor: pointer;
        transition: all 0.2s;
      }
      
      .nav-dropdown-toggle:hover {
        background: #edf2f7;
        border-color: #cbd5e0;
      }
      
      .nav-dropdown-toggle.active {
        background: #667eea;
        color: white;
        border-color: #667eea;
      }
      
      .current-page {
        font-weight: 600;
      }
      
      .dropdown-arrow {
        font-size: 0.8rem;
        transition: transform 0.2s;
      }
      
      .nav-dropdown.open .dropdown-arrow {
        transform: rotate(180deg);
      }
      
      .nav-dropdown-menu {
        position: absolute;
        top: 100%;
        right: 0;
        background: white;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        min-width: 300px;
        opacity: 0;
        visibility: hidden;
        transform: translateY(-10px);
        transition: all 0.2s;
        z-index: 1001;
      }
      
      .nav-dropdown.open .nav-dropdown-menu {
        opacity: 1;
        visibility: visible;
        transform: translateY(0);
      }
      
      .nav-dropdown-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 12px 16px;
        text-decoration: none;
        color: #2d3748;
        border-bottom: 1px solid #f7fafc;
        transition: background 0.2s;
      }
      
      .nav-dropdown-item:hover {
        background: #f7fafc;
      }
      
      .nav-dropdown-item.active {
        background: #ebf8ff;
        border-left: 3px solid #667eea;
      }
      
      .nav-dropdown-item:last-child {
        border-bottom: none;
      }
      
      .item-icon {
        font-size: 1.2rem;
        flex-shrink: 0;
        margin-top: 2px;
      }
      
      .item-content {
        flex: 1;
      }
      
      .item-label {
        font-weight: 600;
        margin-bottom: 2px;
        font-size: 0.9rem;
      }
      
      .item-description {
        font-size: 0.8rem;
        color: #718096;
        line-height: 1.3;
      }
      
      .nav-status {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .status-indicator {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
        padding: 6px 10px;
        background: #f7fafc;
        border-radius: 6px;
        border: 1px solid #e2e8f0;
      }
      
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        animation: pulse 2s infinite;
      }
      
      .status-dot.online {
        background: #10b981;
      }
      
      .status-dot.offline {
        background: #ef4444;
      }
      
      .status-dot.warning {
        background: #f59e0b;
      }
      
      .status-text {
        font-weight: 500;
      }
      
      @keyframes pulse {
        0% { opacity: 1; }
        50% { opacity: 0.5; }
        100% { opacity: 1; }
      }
      
      /* Respect reduced motion preferences */
      @media (prefers-reduced-motion: reduce) {
        .status-dot { animation: none !important; }
        * { transition: none !important; }
      }
      
      /* Responsive */
      @media (max-width: 768px) {
        .nav-container {
          padding: 10px 16px;
          gap: 12px;
        }
        
        .nav-breadcrumbs {
          display: none;
        }
        
        .brand-text {
          font-size: 1.1rem;
        }
        
        .nav-dropdown-menu {
          min-width: 250px;
          right: -16px;
        }
        
        .current-page {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }
      
      /* Add margin to page content to account for fixed nav */
      body {
        padding-top: 70px;
      }
      
      /* Focus styles for accessibility */
      button:focus-visible,
      a:focus-visible {
        outline: 2px solid #667eea;
        outline-offset: 2px;
        border-radius: 4px;
      }
      
      .dashboard-container,
      .container,
      .main-panel {
        margin-top: 0;
      }
    </style>
  `;
}

export function initializeNavigation(): void {
  // Initialize dropdown functionality
  const dropdownToggle = document.getElementById('nav-dropdown-toggle');
  const dropdown = document.getElementById('nav-dropdown');
  const dropdownMenu = document.getElementById('nav-dropdown-menu');
  
  if (dropdownToggle && dropdown && dropdownMenu) {
    dropdownToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains('open');
      dropdown.classList.toggle('open');
      dropdownToggle.setAttribute('aria-expanded', (!isOpen).toString());
      
      // Update tabindex for menu items
      const menuItems = dropdownMenu.querySelectorAll('[role="menuitem"]');
      menuItems.forEach((item, index) => {
        (item as HTMLElement).tabIndex = !isOpen ? 0 : -1;
        if (!isOpen && index === 0) {
          (item as HTMLElement).focus();
        }
      });
    });
    
    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!dropdown.contains(e.target as Node)) {
        dropdown.classList.remove('open');
        dropdownToggle.setAttribute('aria-expanded', 'false');
        // Reset tabindex for menu items
        const menuItems = dropdownMenu.querySelectorAll('[role="menuitem"]');
        menuItems.forEach((item) => {
          (item as HTMLElement).tabIndex = -1;
        });
      }
    });
    
    // Keyboard navigation for dropdown
    dropdownMenu.addEventListener('keydown', (e) => {
      const menuItems = Array.from(dropdownMenu.querySelectorAll('[role="menuitem"]')) as HTMLElement[];
      const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
      
      switch (e.key) {
        case 'Escape':
          dropdown.classList.remove('open');
          dropdownToggle.setAttribute('aria-expanded', 'false');
          dropdownToggle.focus();
          menuItems.forEach(item => item.tabIndex = -1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          const nextIndex = (currentIndex + 1) % menuItems.length;
          menuItems[nextIndex].focus();
          break;
        case 'ArrowUp':
          e.preventDefault();
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : menuItems.length - 1;
          menuItems[prevIndex].focus();
          break;
      }
    });
  }
  
  // Initialize system status check
  checkSystemStatus();
  
  // Update status every 30 seconds (use requestIdleCallback if available)
  const updateInterval = () => {
    checkSystemStatus();
  };
  
  if (window.requestIdleCallback) {
    const scheduleUpdate = () => {
      window.requestIdleCallback(() => {
        updateInterval();
        setTimeout(scheduleUpdate, 30000);
      });
    };
    scheduleUpdate();
  } else {
    setInterval(updateInterval, 30000);
  }
}

async function checkSystemStatus(): Promise<void> {
  const statusIndicator = document.getElementById('system-status');
  const statusDot = statusIndicator?.querySelector('.status-dot');
  const statusText = statusIndicator?.querySelector('.status-text');
  
  if (!statusIndicator || !statusDot || !statusText) return;
  
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    
    if (health.status === 'healthy') {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'System Online';
    } else {
      statusDot.className = 'status-dot warning';
      statusText.textContent = 'System Issues';
    }
  } catch (error) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'System Offline';
  }
}

// Auto-initialize when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeNavigation);
  } else {
    initializeNavigation();
  }
}