/* Cookie Consent Banner – Heritage Bank */
(function () {
    var stored = localStorage.getItem('cookieConsent');
    if (stored) return;

    var banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
        '<div class="cookie-consent-inner">' +
            '<p>We use cookies to enhance your experience. By continuing to visit this site you agree to our use of cookies. ' +
            '<a href="cookie-policy.html">Learn more</a></p>' +
            '<div id="cookie-categories" class="cookie-categories" style="display:none;">' +
                '<label class="cookie-cat"><input type="checkbox" checked disabled> <strong>Essential</strong> <span>(always on)</span></label>' +
                '<label class="cookie-cat"><input type="checkbox" id="ck-analytics"> <strong>Analytics</strong> <span>– helps us improve</span></label>' +
                '<label class="cookie-cat"><input type="checkbox" id="ck-marketing"> <strong>Marketing</strong> <span>– personalised ads</span></label>' +
            '</div>' +
            '<div class="cookie-consent-buttons">' +
                '<button id="cookie-accept-all" class="cookie-btn cookie-btn-accept">Accept All</button>' +
                '<button id="cookie-customize" class="cookie-btn cookie-btn-essential">Customize</button>' +
                '<button id="cookie-save" class="cookie-btn cookie-btn-accept" style="display:none;">Save Preferences</button>' +
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
            'font-family:"Inter","Segoe UI",Tahoma,Geneva,Verdana,sans-serif;' +
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
        '.cookie-categories{' +
            'width:100%;display:flex;gap:18px;flex-wrap:wrap;padding:10px 0 4px' +
        '}' +
        '.cookie-cat{display:flex;align-items:center;gap:6px;cursor:pointer}' +
        '.cookie-cat input{width:16px;height:16px;accent-color:#d4af37}' +
        '.cookie-cat span{color:#b5c5b5;font-size:12px}' +
        '@media(max-width:600px){' +
            '.cookie-consent-inner{flex-direction:column;text-align:center}' +
            '.cookie-consent-buttons{justify-content:center;flex-wrap:wrap}' +
            '.cookie-categories{justify-content:center}' +
        '}';

    document.head.appendChild(style);
    document.body.appendChild(banner);

    function dismiss(prefs) {
        localStorage.setItem('cookieConsent', JSON.stringify(prefs));
        banner.remove();
    }

    document.getElementById('cookie-accept-all').addEventListener('click', function () {
        dismiss({ essential: true, analytics: true, marketing: true });
    });
    document.getElementById('cookie-essential').addEventListener('click', function () {
        dismiss({ essential: true, analytics: false, marketing: false });
    });
    document.getElementById('cookie-customize').addEventListener('click', function () {
        document.getElementById('cookie-categories').style.display = 'flex';
        document.getElementById('cookie-save').style.display = '';
        this.style.display = 'none';
    });
    document.getElementById('cookie-save').addEventListener('click', function () {
        dismiss({
            essential: true,
            analytics: !!document.getElementById('ck-analytics').checked,
            marketing: !!document.getElementById('ck-marketing').checked
        });
    });
})();
