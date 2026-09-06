#!/usr/bin/env python3
"""
Inject the shared nav and footer into every page, and version every asset URL.

The site is plain static files with no framework, but the nav and footer would
otherwise be hand-copied into each page, so changing a link would mean editing
every one of them and one would drift. The markup lives once in partials/ and
this script stamps it between the BUILD markers. Pages stay real static HTML --
nothing depends on JavaScript and there is nothing for a crawler to miss.

Placeholders:
  {{ROOT}}  relative path back to the site root ("", "../", "../../", ...)
  {{HOME}}  how a page links to the homepage for an in-page anchor; empty on
            index.html so "#about" scrolls instead of navigating

Idempotent: run it as often as you like. Run it after editing partials/ or any
CSS/JS. `--check` reports whether anything is stale without writing.
"""
import hashlib
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

PAGES = {
    "index.html": "",
    "pages/linkage.html": "../",
}

BLOCKS = {"nav": "partials/nav.html", "footer": "partials/footer.html"}

VERSION_RE = re.compile(r"\?v=[0-9a-f]{8}")


def asset_paths():
    """Every local stylesheet and script, including the js/linkage/ modules."""
    out = []
    for rel_dir in ("css", "js"):
        base = os.path.join(ROOT, rel_dir)
        for dirpath, _dirnames, filenames in os.walk(base):
            for name in sorted(filenames):
                if name.endswith((".css", ".js")):
                    full = os.path.join(dirpath, name)
                    out.append(os.path.relpath(full, ROOT))
    return sorted(out)


def stamp():
    """Short hash of the assets, so a deploy changes every asset URL.

    GitHub Pages serves assets with max-age=600. Without a version in the URL a
    visitor keeps running ten-minute-old JavaScript after a deploy, which looks
    exactly like the fix not working.

    Version markers are stripped before hashing. Otherwise stamping a file
    would change its content, which would change the hash, which would demand a
    different stamp -- the hash would never settle and every run would report
    the site as stale. Hashing the un-stamped bytes makes the tag a fixed point.
    """
    h = hashlib.sha256()
    for rel in asset_paths():
        with open(os.path.join(ROOT, rel), "rb") as f:
            h.update(rel.encode())
            h.update(VERSION_RE.sub("", f.read().decode()).encode())
    return h.hexdigest()[:8]


def version_html_assets(html, tag):
    """Point every local css/js reference in a page at ...?v=<hash>."""
    def sub(m):
        base = m.group(2).split("?")[0]
        return f'{m.group(1)}="{base}?v={tag}"'
    return re.sub(
        r'(href|src)="((?:\.\./)*(?:css|js)/[\w./-]+\.(?:css|js))(?:\?v=[0-9a-f]{8})?"',
        sub, html
    )


def version_module_imports(src, tag):
    """Point every relative ES-module specifier at ...?v=<hash>.

    The linkage engine is a set of modules importing each other, so versioning
    only the <script src> would let a fresh entry point pull a stale solver --
    the exact failure the version tag exists to prevent.
    """
    def sub(m):
        return f'{m.group(1)}{m.group(2)}?v={tag}{m.group(3)}'
    return re.sub(
        r'(from\s+|import\(\s*)(["\'](?:\.{1,2}/)[\w./-]+\.js)(?:\?v=[0-9a-f]{8})?(["\'])',
        lambda m: f'{m.group(1)}{m.group(2)}?v={tag}{m.group(3)}',
        src
    )


def main():
    check = "--check" in sys.argv
    tag = stamp()
    changed = []

    for rel in asset_paths():
        if not rel.endswith(".js"):
            continue
        path = os.path.join(ROOT, rel)
        with open(path) as f:
            original = f.read()
        updated = version_module_imports(original, tag)
        if updated != original:
            changed.append(rel)
            if not check:
                with open(path, "w") as f:
                    f.write(updated)

    for page, root in PAGES.items():
        path = os.path.join(ROOT, page)
        with open(path) as f:
            html = original_html = f.read()

        home = "" if page == "index.html" else root + "index.html"
        for name, src in BLOCKS.items():
            with open(os.path.join(ROOT, src)) as f:
                body = f.read().replace("{{ROOT}}", root).replace("{{HOME}}", home).rstrip("\n")
            pattern = re.compile(
                r"(<!-- BUILD:%s -->\n).*?(\n\s*<!-- /BUILD:%s -->)" % (name, name), re.S
            )
            if not pattern.search(html):
                sys.exit(f"error: {page} is missing the BUILD:{name} markers")
            html = pattern.sub(lambda m: m.group(1) + body + m.group(2), html)

        html = version_html_assets(html, tag)
        if html != original_html:
            changed.append(page)
            if not check:
                with open(path, "w") as f:
                    f.write(html)

    if check:
        print("stale:" if changed else "all pages up to date", *changed)
        sys.exit(1 if changed else 0)
    print(f"stamped v={tag}; updated {len(changed)} file(s)"
          + (": " + ", ".join(changed) if changed else ""))


if __name__ == "__main__":
    main()
