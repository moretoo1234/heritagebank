/* Cookie Consent Banner – Heritage Bank */
(function () {
    if (localStorage.getItem('cookieConsent')) return;

    var banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
        '<div class="cookie-consent-inner">' +
            '<p>We use cookies to enhance your experience. By continuing to visit this site you agree to our use of cookies. ' +
            '<a href="cookie-policy.html">Learn more</a></p>' +
            '<div class="cookie-consent-buttons">' +
                '<button id="cookie-accept-all" class="cookie-btn cookie-btn-accept">Accept All</button>' +
                '<button id="cookie-essential" class="cookie-btn cookie-btn-essential">Essential Only</button>' +
            '</div>' +
        '</div>';

    /* ---------- styles ---------- */
    var style = document.createElement('style');
    style.textContent =
        '#cookie-consent-banner{' +
            'position:fixed;bottom:0;left:0;right:0;' +
            'background:#1a472a;color:#fff;' +
            'padding:16px 20px;z-index:10000;' +
            'box-shadow:0 -2px 10px rgba(0,0,0,.3);' +
            'font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;' +
            'font-size:14px;line-height:1.5' +
        '}' +
        '.cookie-consent-inner{' +
            'max-width:1200px;margin:0 auto;' +
            'display:flex;align-items:center;justify-content:space-between;' +
            'gap:20px;flex-wrap:wrap' +
        '}' +
        '.cookie-consent-inner p{margin:0;flex:1 1 400px}' +
        '.cookie-consent-inner a{color:#d4af37;text-decoration:underline}' +
        '.cookie-consent-buttons{display:flex;gap:10px;flex-shrink:0}' +
        '.cookie-btn{' +
            'border:none;cursor:pointer;padding:10px 22px;border-radius:6px;' +
            'font-size:14px;font-weight:600;transition:opacity .2s' +
        '}' +
        '.cookie-btn:hover{opacity:.85}' +
        '.cookie-btn-accept{background:#d4af37;color:#1a472a}' +
        '.cookie-btn-essential{background:transparent;color:#fff;border:1px solid #fff}' +
        '@media(max-width:600px){' +
            '.cookie-consent-inner{flex-direction:column;text-align:center}' +
            '.cookie-consent-buttons{justify-content:center}' +
        '}';

    document.head.appendChild(style);
    document.body.appendChild(banner);

    function dismiss(level) {
        localStorage.setItem('cookieConsent', level);
        banner.remove();
    }

    document.getElementById('cookie-accept-all').addEventListener('click', function () {
        dismiss('all');
    });
    document.getElementById('cookie-essential').addEventListener('click', function () {
        dismiss('essential');
    });
})();
