/* Turning model output into DOM.

   Escape-first and node-by-node: nothing the model writes is ever assigned to
   innerHTML. A local model cannot be prompt-injected by a remote page, but the
   visitor's own typing comes back through the transcript, so the renderer is
   built as if the text were hostile. */

/* Models often inline bullets mid-paragraph ("layers: * gateway ... * metering
   ..."), which would otherwise render as literal asterisks. A space-flanked
   asterisk is always a bullet: "**bold**" never has a space between its
   asterisks, so this cannot damage a bold marker. */
function normalizeBullets(text) {
  return text.replace(/[ \t]\*[ \t]/g, "\n- ");
}

/* Only same-origin and site-relative hrefs. The assistant offers links into the
   two simulators; it has no business linking anywhere else, and a link it made
   up is a link that should not be clickable. */
export function safeHref(href) {
  /* A protocol-relative URL is not a site-relative one. "//evil.com/x" matches
     a leading-slash test with zero dots and contains no "://", so it was being
     returned verbatim and rendered as a clickable link off this origin; "/\evil"
     gets there too, because browsers normalise the backslash. Anything whose
     second character is another slash goes through the URL parse below, which
     only lets same-origin through. */
  if (/^[/\\]{2}/.test(href)) return null;
  if (/^(\.{0,2}\/|#)/.test(href) && !href.includes("://")) return href;
  try {
    const u = new URL(href, location.href);
    if (u.origin === location.origin) return u.pathname + u.search + u.hash;
  } catch (e) { /* not a URL at all */ }
  return null;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/;

function inline(parent, text) {
  for (const piece of text.split(INLINE)) {
    if (!piece) continue;
    if (piece.startsWith("**") && piece.endsWith("**")) {
      const b = document.createElement("strong");
      b.textContent = piece.slice(2, -2);
      parent.appendChild(b);
    } else if (piece.startsWith("`") && piece.endsWith("`")) {
      const c = document.createElement("code");
      c.textContent = piece.slice(1, -1);
      parent.appendChild(c);
    } else if (piece.startsWith("[")) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(piece);
      const href = m && safeHref(m[2]);
      if (href) {
        const a = document.createElement("a");
        a.href = href;
        a.textContent = m[1];
        parent.appendChild(a);
      } else {
        parent.appendChild(document.createTextNode(m ? m[1] : piece));
      }
    } else {
      parent.appendChild(document.createTextNode(piece));
    }
  }
}

export function render(text) {
  const frag = document.createDocumentFragment();
  for (const block of normalizeBullets(text).split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim());
    const isList = lines.length > 0 && lines.every((l) => /^\s*(?:[-*•]|\d+\.)\s+/.test(l));
    if (isList) {
      const ul = document.createElement("ul");
      for (const line of lines) {
        const li = document.createElement("li");
        inline(li, line.replace(/^\s*(?:[-*•]|\d+\.)\s+/, ""));
        ul.appendChild(li);
      }
      frag.appendChild(ul);
    } else if (lines.length) {
      const p = document.createElement("p");
      inline(p, block);
      frag.appendChild(p);
    }
  }
  return frag;
}

/* Rebuilding the answer's DOM on every token is quadratic in the length of the
   answer and forces a reflow per token. Coalesce to one render per frame. */
export function streamInto(body, log) {
  let pending = null;
  let queued = false;
  const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const flush = () => {
    queued = false;
    if (pending === null) return;
    /* The reader may have scrolled up to re-read an earlier answer while this
       one streams, so only pin to the bottom when they are already there. */
    const stick = nearBottom();
    body.replaceChildren(render(pending));
    pending = null;
    if (stick) log.scrollTop = log.scrollHeight;
  };
  return {
    update(text) {
      pending = text;
      if (!queued) { queued = true; requestAnimationFrame(flush); }
    },
    finish(text) { pending = text; flush(); },
  };
}

export function attachCopy(el, getText) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy-btn";
  btn.textContent = "copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "copied";
    } catch (e) {
      btn.textContent = "press ctrl+c";   /* clipboard blocked, e.g. no secure context */
    }
    setTimeout(() => { btn.textContent = "copy"; }, 1600);
  });
  el.appendChild(btn);
}

/* The one tag the model is allowed to write back. It is pulled out and turned
   into a button by ui.js; here it is removed from what is shown, because this
   renderer is escape-first and sets textContent, so an unstripped tag would
   appear on screen as literal angle brackets. It is stripped before the answer
   is remembered too, so it never re-enters the conversation as history. */
export const TRY = /<try>([\s\S]*?)<\/try>/i;
export const stripTry = (t) => t.replace(/<try>[\s\S]*?(?:<\/try>|$)/gi, "").trim();

/* Small models keep opening by citing their own context. */
const PREAMBLE = /^\s*(?:based on|according to|from|per)\s+(?:the\s+)?(?:provided\s+)?(?:profile|information|context|details|background)[^,.:;]*[,.:;]\s*/i;
export function stripPreamble(t) {
  const out = t.replace(PREAMBLE, "");
  return out === t ? t : out.charAt(0).toUpperCase() + out.slice(1);
}

/* The prompt hands the model a refusal sentence for off-topic questions, and a
   small model sometimes staples it onto a perfectly good answer. Drop it when
   there is real content in front of it; leave a bare refusal alone. */
const REFUSAL_TAIL = /\s*I only answer questions about Mark['’]?s background and the tools on this site\.?\s*$/i;
export function stripRefusalTail(t) {
  const out = t.replace(REFUSAL_TAIL, "").trim();
  return out.length > 20 ? out : t;
}
