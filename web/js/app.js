document.addEventListener('DOMContentLoaded', () => {
    // 0. Sidebar Collapse Toggle
    const btnToggleSidebar = document.getElementById('btnToggleSidebar');
    const sidebar = document.getElementById('sidebar');

    if (btnToggleSidebar && sidebar) {
        if (localStorage.getItem('sidebar_collapsed') === 'true') {
            sidebar.classList.add('collapsed');
        }

        btnToggleSidebar.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
            localStorage.setItem('sidebar_collapsed', sidebar.classList.contains('collapsed'));
            // Dispatch resize event to trigger canvas redrawing
            window.dispatchEvent(new Event('resize'));
        });
    }

    // 1. Sidebar Tab Switching
    const navItems = document.querySelectorAll('.nav-item[data-panel]');
    const tabPanels = document.querySelectorAll('.tab-panel');
    const topBarTitle = document.getElementById('topBarTitle');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            // Remove active from all nav items and panels
            navItems.forEach(nav => nav.classList.remove('active'));
            tabPanels.forEach(panel => panel.classList.remove('active'));

            // Add active to clicked nav item
            item.classList.add('active');
            
            // Show corresponding panel
            const panelId = 'panel-' + item.getAttribute('data-panel');
            const panel = document.getElementById(panelId);
            if (panel) {
                panel.classList.add('active');
            }

            // Update title (get text without icon)
            if (topBarTitle) {
                const textSpan = item.querySelector('span:not(.nav-item-icon)');
                if (textSpan) {
                    topBarTitle.innerText = textSpan.innerText;
                }
            }

            // Trigger preview updates if tab has canvas previews
            if (window.updateSigPreview) {
                setTimeout(() => window.updateSigPreview(), 20);
            }
            if (window.updatePwmDacPreview) {
                setTimeout(() => window.updatePwmDacPreview(), 20);
            }
            if (window.updateLogicPreview) {
                setTimeout(() => window.updateLogicPreview(), 20);
            }
        });
    });

    // 2. Settings Toggle
    const btnSettings = document.getElementById('btnSettings');
    const voltConfig = document.getElementById('voltConfig');
    if (btnSettings && voltConfig) {
        btnSettings.addEventListener('click', () => {
            voltConfig.classList.toggle('collapsed');
        });
    }

    // 3. DC/AC Mode Toggle
    const modeToggle = document.getElementById('modeToggle');
    if (modeToggle) {
        const options = modeToggle.querySelectorAll('.mode-toggle-option');
        options.forEach(opt => {
            opt.addEventListener('click', (e) => {
                // Prevent event bubbling if clicking exactly on option
                e.stopPropagation();
                
                options.forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                
                const value = opt.getAttribute('data-value');
                modeToggle.setAttribute('data-mode', value);
                
                // Update voltmeter config & AC panel visibility
                if(window.voltConfig) {
                    window.voltConfig.mode = value;
                }
                const acCard = document.getElementById('voltAcMetricsCard');
                if (acCard) {
                    acCard.style.display = (value === 'ac') ? 'block' : 'none';
                }
            });
        });
    }
    
    // Bias Toggle is handled by voltmeter.js
});
