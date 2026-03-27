// Heritage Bank - App Sidebar
// Auto-injects sidebar navigation and layout wrapper into app pages
(function() {
    const pageMap = {
        'dashboard.html':    { label: 'Dashboard',      icon: 'fa-th-large',          section: 'main' },
        'transfer.html':     { label: 'Transfer',       icon: 'fa-paper-plane',       section: 'main' },
        'pay-bills.html':    { label: 'Pay Bills',      icon: 'fa-file-invoice-dollar',section: 'main' },
        'mobile-deposit.html':{ label: 'Mobile Deposit', icon: 'fa-camera',            section: 'main' },
        'transactions.html': { label: 'Transactions',   icon: 'fa-exchange-alt',      section: 'main' },
        'cards.html':        { label: 'Cards',          icon: 'fa-credit-card',       section: 'products' },
        'investment.html':   { label: 'Investments',    icon: 'fa-chart-line',        section: 'products' },
        'request-loan.html': { label: 'Loans',          icon: 'fa-hand-holding-usd',  section: 'products' },
        'savings-goals.html':{ label: 'Savings Goals',  icon: 'fa-piggy-bank',        section: 'products' },
        'analytics.html':    { label: 'Analytics',      icon: 'fa-chart-pie',         section: 'others' },
        'statements.html':   { label: 'Statements',     icon: 'fa-file-alt',          section: 'others' },
        'messages.html':     { label: 'Messages',       icon: 'fa-envelope',          section: 'others' },
        'support.html':      { label: 'Support',        icon: 'fa-headset',           section: 'others' },
        'settings.html':     { label: 'Settings',       icon: 'fa-cog',               section: 'others' },
    };

    var currentPage = window.location.pathname.split('/').pop() || 'index.html';
    // Skip dashboard (has its own sidebar)
    if (currentPage === 'dashboard.html') return;

    function buildMenu(section) {
        var html = '';
        for (var page in pageMap) {
            var info = pageMap[page];
            if (info.section !== section) continue;
            var active = (page === currentPage) ? ' class="active"' : '';
            html += '<li' + active + ' onclick="location.href=\'' + page + '\'"><i class="fas ' + info.icon + '"></i> ' + info.label + '</li>';
        }
        return html;
    }

    var sidebarHTML =
        '<div class="sidebar-overlay" id="sidebarOverlay"></div>' +
        '<nav class="app-sidebar" id="appSidebar">' +
            '<a class="sidebar-logo" href="dashboard.html">' +
                '<img src="assets/logo.png" alt="Heritage Bank" onerror="this.style.display=\'none\'">' +
                '<span>Heritage Bank</span>' +
            '</a>' +
            '<div class="sidebar-section">Main Menu</div>' +
            '<ul class="sidebar-menu">' + buildMenu('main') + '</ul>' +
            '<div class="sidebar-divider"></div>' +
            '<div class="sidebar-section">Products</div>' +
            '<ul class="sidebar-menu">' + buildMenu('products') + '</ul>' +
            '<div class="sidebar-divider"></div>' +
            '<div class="sidebar-section">Others</div>' +
            '<ul class="sidebar-menu">' + buildMenu('others') + '</ul>' +
            '<div class="sidebar-bottom">' +
                '<button class="logout-sidebar-btn" onclick="logout()"><i class="fas fa-sign-out-alt"></i> Log Out</button>' +
            '</div>' +
        '</nav>';

    // Page title detection
    var pageTitle = '';
    if (pageMap[currentPage]) pageTitle = pageMap[currentPage].label;

    // Check if page already has a sidebar layout
    var existingSidebar = document.querySelector('.sidebar') || document.querySelector('.app-sidebar');
    var existingDashboard = document.querySelector('.dashboard');

    if (existingSidebar && existingDashboard) {
        // Replace existing sidebar content with updated menu
        existingSidebar.outerHTML = sidebarHTML.replace('class="sidebar-overlay"', 'class="sidebar-overlay"').split('</nav>')[0] + '</nav>';
        existingDashboard.className = 'app-layout';
        var mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.className = 'app-main';
        // Add overlay
        if (!document.getElementById('sidebarOverlay')) {
            existingDashboard.insertAdjacentHTML('afterbegin', '<div class="sidebar-overlay" id="sidebarOverlay"></div>');
        }
    } else if (!existingSidebar) {
        // Wrap page content in app-layout
        var body = document.body;
        var layout = document.createElement('div');
        layout.className = 'app-layout';
        var main = document.createElement('main');
        main.className = 'app-main';

        // Collect non-script body children
        var children = [];
        for (var i = 0; i < body.children.length; i++) {
            if (body.children[i].tagName !== 'SCRIPT') {
                children.push(body.children[i]);
            }
        }
        for (var j = 0; j < children.length; j++) {
            main.appendChild(children[j]);
        }

        layout.insertAdjacentHTML('afterbegin', sidebarHTML);
        layout.appendChild(main);
        body.insertBefore(layout, body.firstChild);

        // Replace old header/back-button with mobile toggle + title
        var oldHeader = main.querySelector('.header');
        var backLink = main.querySelector('.back-link');
        if (oldHeader) {
            var h1 = oldHeader.querySelector('h1');
            var title = h1 ? h1.textContent : pageTitle;
            var newHeader = document.createElement('div');
            newHeader.className = 'app-main-header';
            newHeader.innerHTML = '<button class="mobile-sidebar-toggle" id="mobileSidebarToggle"><i class="fas fa-bars"></i></button><h1 class="app-page-title">' + title + '</h1>';
            oldHeader.parentNode.replaceChild(newHeader, oldHeader);
        } else if (backLink) {
            var newHeaderEl = document.createElement('div');
            newHeaderEl.className = 'app-main-header';
            newHeaderEl.innerHTML = '<button class="mobile-sidebar-toggle" id="mobileSidebarToggle"><i class="fas fa-bars"></i></button><h1 class="app-page-title">' + pageTitle + '</h1>';
            backLink.parentNode.replaceChild(newHeaderEl, backLink);
        } else {
            // No header found, prepend a mobile toggle header
            var headerDiv = document.createElement('div');
            headerDiv.className = 'app-main-header';
            headerDiv.innerHTML = '<button class="mobile-sidebar-toggle" id="mobileSidebarToggle"><i class="fas fa-bars"></i></button><h1 class="app-page-title">' + pageTitle + '</h1>';
            main.insertBefore(headerDiv, main.firstChild);
        }
    }

    // Mobile toggle events
    setTimeout(function() {
        var toggle = document.getElementById('mobileSidebarToggle');
        var sidebar = document.getElementById('appSidebar');
        var overlay = document.getElementById('sidebarOverlay');

        if (toggle && sidebar) {
            toggle.addEventListener('click', function() {
                sidebar.classList.toggle('open');
                if (overlay) overlay.classList.toggle('active');
            });
        }
        if (overlay) {
            overlay.addEventListener('click', function() {
                if (sidebar) sidebar.classList.remove('open');
                overlay.classList.remove('active');
            });
        }
    }, 0);

    // Logout function
    if (typeof window.logout !== 'function') {
        window.logout = function() {
            var token = localStorage.getItem('token');
            var API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
                ? 'http://localhost:3001' : window.location.origin;
            if (token) {
                fetch(API_URL + '/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                }).catch(function(){});
            }
            localStorage.removeItem('token');
            localStorage.removeItem('user');
            window.location.href = 'signin.html';
        };
    }
})();
