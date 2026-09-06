/* Shared site behavior: theme, nav, scroll reveal, year stamp. */
(function () {
  // --- theme -------------------------------------------------------------
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('theme'); } catch (e) {}
  if (stored === 'light') root.setAttribute('data-theme', 'light');

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
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
        });
      }, { threshold: 0.08, rootMargin: '0px 0px -40px' });
      targets.forEach(function (el) { io.observe(el); });
    }

    // --- year stamp ------------------------------------------------------
    document.querySelectorAll('[data-year]').forEach(function (el) {
      el.textContent = String(new Date().getFullYear());
    });
  });
})();
