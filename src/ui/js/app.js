// nAlytics app — NUI shell, navigation, router.
import { nui } from '/analytics/nui/nui.js';
import './page-init.js';

// Global app actions (data-action system)
document.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const [actionPart] = actionEl.dataset.action.split('@');
    const [action, param] = actionPart.split(':');

    switch (action) {
        case 'toggle-sidebar':
            document.querySelector('nui-app')?.toggleSidebar(param || 'left');
            break;
        case 'toggle-theme':
            const current = document.documentElement.style.colorScheme || 'light';
            document.documentElement.style.colorScheme = current === 'dark' ? 'light' : 'dark';
            break;
    }
});

// Sidebar navigation
const navigationData = [
    { label: 'Overview', href: '#page=overview', icon: 'analytics' },
    { label: 'Raw Rows', href: '#page=raw', icon: 'table_rows' }
];

const sideNav = document.getElementById('main-navigation');
if (sideNav && sideNav.loadData) {
    sideNav.loadData(navigationData);
}

// Router: `#page=overview` loads app/pages/overview.html into <nui-main>
// basePath must be absolute — the document URL /analytics has no trailing slash,
// so a relative base would resolve against / and 404.
nui.setupRouter({
    container: 'nui-content nui-main',
    navigation: 'nui-sidebar#nav-sidebar',
    basePath: '/analytics/app/pages',
    defaultPage: 'overview'
});
