/* Shared site behavior: theme, nav, scroll reveal, year stamp. */
(function () {
  // --- theme -------------------------------------------------------------
  var root = document.documentElement;
  root.classList.add('js');
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  /* Same rule as the inline head script, which has already run: an explicit
     stored choice wins, and only in its absence does the OS preference decide.
     Repeated here so the theme is still right if the inline script was the
     thing that failed. Nothing is ever WRITTEN here -- a preference the
     visitor has not stated must not become a stored choice, or the toggle
     would have nothing to fall back to. */
  var prefersLight = window.matchMedia
    && window.matchMedia('(prefers-color-scheme: light)').matches;
  if (stored === 'light' || (!stored && prefersLight)) {
    root.setAttribute('data-theme', 'light');
  }

  window.addEventListener('DOMContentLoaded', function () {
    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var light = root.getAttribute('data-theme') === 'light';
        if (light) root.removeAttribute('data-theme');
        else root.setAttribute('data-theme', 'light');
        try { localStorage.setItem('theme', light ? 'dark' : 'light'); } catch (e) {}
        /* The canvases paint with resolved CSS custom properties, so they have
           to repaint on a theme change rather than inheriting it. */
        window.dispatchEvent(new CustomEvent('themechange'));
      });
    }

    // --- mobile nav ------------------------------------------------------
    var navBtn = document.querySelector('[data-nav-toggle]');
    var navLinks = document.querySelector('.nav-links');
    if (navBtn && navLinks) {
      navBtn.addEventListener('click', function () {
        var open = navLinks.classList.toggle('open');
        navBtn.setAttribute('aria-expanded', String(open));
      });
      navLinks.addEventListener('click', function (e) {
        if (e.target.tagName === 'A') {
          navLinks.classList.remove('open');
          navBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // --- sticky nav border ----------------------------------------------
    var nav = document.querySelector('.nav');
    if (nav) {
      var onScroll = function () { nav.classList.toggle('is-stuck', window.scrollY > 8); };
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    // --- scroll reveal ---------------------------------------------------
    var targets = document.querySelectorAll('.reveal');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('in'); });
    } else {
      /* Reveal targets are individual cards and timeline entries rather than
         whole sections, so a fast scroll never lands on an empty section
         waiting out a fade. Several usually cross the threshold in the same
         callback, and firing them together is a flash rather than a reveal, so
         stagger only that batch -- one arriving alone still starts at once. */
      var io = new IntersectionObserver(function (entries) {
        var arriving = entries.filter(function (e) { return e.isIntersecting; });
        arriving.forEach(function (entry, i) {
          if (i) entry.target.style.transitionDelay = (i * 60) + 'ms';
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px' });
      targets.forEach(function (el) { io.observe(el); });
    }

    // --- email links -----------------------------------------------------
    /* The address never appears in the served HTML: it is carried as two
       halves and joined here. That defeats the naive `mailto:` and plain-text
       scrapes without hiding it from a person, since the finished link and
       its label both read normally. Each link ships `hidden` and is revealed
       only once it has a working href, so a failure here leaves no dead
       button -- just the LinkedIn and GitHub routes that were always there. */
    document.querySelectorAll('[data-mailto]').forEach(function (el) {
      var user = el.getAttribute('data-mailto-user');
      var domain = el.getAttribute('data-mailto-domain');
      if (!user || !domain) return;
      var addr = user + '@' + domain;
      el.setAttribute('href', 'mailto:' + addr);
      var label = el.querySelector('[data-mailto-label]');
      if (label) label.textContent = addr;
      el.hidden = false;
    });

    // --- year stamp ------------------------------------------------------
    document.querySelectorAll('[data-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  });
})();
