// Applies the viewer's Settings (theme, accent, text size) to the sign-in and admin pages before first paint.
(() => {
    try {
        const saved = JSON.parse(localStorage.getItem('dcmviewer.uiSettings') || 'null') || {};
        const light = saved.theme === 'light' || (saved.theme === 'system' && matchMedia('(prefers-color-scheme: light)').matches);
        document.documentElement.dataset.theme = light ? 'light' : 'dark';
        if (/^#[0-9a-f]{6}$/i.test(saved.accent)) document.documentElement.style.setProperty('--accent', saved.accent);
        if (typeof saved.textScale === 'number') document.documentElement.style.setProperty('--text-scale', String(Math.min(Math.max(saved.textScale, 0.85), 1.3)));
    } catch { /* storage blocked: defaults */ }
})();
