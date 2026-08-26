"use strict";
/**
 * Takes over YouTube's own Download button (the Premium one) on watch pages: hides it
 * and puts an identical-looking button in its place that downloads through this
 * extension instead. Modelled on how the SaveBridge extension did it — harvest the
 * native button's markup so ours inherits YouTube's exact styling even as YouTube
 * changes it, rather than hand-maintaining a copy of their CSS.
 */
(() => {
  const PRESETS = [
    { quality: "best", label: "וידאו - איכות מיטבית" },
    { quality: "1080", label: "וידאו - 1080p" },
    { quality: "720", label: "וידאו - 720p" },
    { quality: "480", label: "וידאו - 480p" },
    { quality: "audio", label: "אודיו בלבד (MP3)" }
  ];

  const DOWNLOAD_LABELS = /download|הורד|הורדה|تنزيل/i;
  const SHARE_LABELS = /share|שיתוף|שתף|مشاركة/i;
  const MENU_POPUP_SELECTOR =
    'ytd-menu-popup-renderer, tp-yt-iron-dropdown, ytd-popup-container, tp-yt-paper-listbox, ytd-menu-service-item-renderer, [role="menu"], [role="menuitem"]';
  // Ordered most- to least-specific. The button is inserted into whichever of these
  // exists and is visible — it never depends on YouTube offering a Download button of
  // its own, so it shows up the same with or without Premium.
  const CONTAINER_SELECTORS = [
    "ytd-watch-metadata #top-level-buttons-computed",
    "ytd-watch-metadata #actions #menu #top-level-buttons-computed",
    "#top-level-buttons-computed",
    "ytd-watch-metadata #actions-inner #menu",
    "ytd-menu-renderer #top-level-buttons-computed",
    "ytd-watch-metadata #actions-inner",
    "ytd-watch-metadata #actions"
  ];
  const TEMPLATE_KEY = "ytproxy:dl-button-html";
  const SHAPE_CLASSES =
    "yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m yt-spec-button-shape-next--icon-leading";
  const ICON_SVG =
    '<svg viewBox="0 0 24 24" width="24" height="24" focusable="false" aria-hidden="true" style="pointer-events:none;display:block;width:100%;height:100%;"><path fill="currentColor" d="M17 18v1.5H7V18h10zM12 3v9.17l3.59-3.58L17 10l-5 5-5-5 1.41-1.42L11 12.17V3h1z"/></svg>';

  let handle = null;
  let menuEl = null;
  let debounceTimer = null;
  let buttonLabel = "הורדה";

  const isWatchPage = () =>
    location.pathname === "/watch" && new URLSearchParams(location.search).has("v");

  function findActionsContainer() {
    for (const selector of CONTAINER_SELECTORS) {
      const el = document.querySelector(selector);
      if (el && el.offsetParent !== null) return el;
    }
    return document.querySelector("ytd-watch-metadata #actions");
  }

  function labeledButtons(container) {
    return Array.from(
      container.querySelectorAll('ytd-button-renderer, yt-button-view-model, button, [role="button"]')
    ).filter((el) => !el.closest(".ytproxy-action"));
  }

  function outerAction(el) {
    return el.closest("ytd-button-renderer") || el.closest("yt-button-view-model") || el;
  }

  function matchLabel(el, re) {
    return re.test(`${el.getAttribute("aria-label") || ""} ${el.textContent || ""}`);
  }

  function findDownloadControl(scope) {
    const chosen = labeledButtons(scope).find(
      (el) => matchLabel(el, DOWNLOAD_LABELS) && !el.closest(MENU_POPUP_SELECTOR) && el.offsetParent !== null
    );
    return chosen ? outerAction(chosen) : null;
  }

  function readVideoMeta() {
    const videoId = new URLSearchParams(location.search).get("v");
    const titleEl =
      document.querySelector("ytd-watch-metadata h1 yt-formatted-string") ||
      document.querySelector("ytd-watch-metadata h1") ||
      document.querySelector("h1.title");
    const docTitle = document.title.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    const title = (titleEl ? titleEl.textContent : "").trim() || docTitle || null;
    return { title, videoId, url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href };
  }

  /* ----------------------------------------------------------- native button */

  // YouTube restyles these buttons regularly, so instead of pinning our own copy of
  // their CSS we clone the real button's markup and just swap the label/handler.
  function harvestTemplate(nativeEl) {
    const inner = nativeEl.querySelector("button");
    if (!inner) return;
    const html = inner.outerHTML;
    if (!html || html.length > 20000) return;
    try {
      sessionStorage.setItem(TEMPLATE_KEY, html);
    } catch {
      /* private mode / storage full — the fallback button covers it */
    }
  }

  function readTemplate() {
    try {
      return sessionStorage.getItem(TEMPLATE_KEY);
    } catch {
      return null;
    }
  }

  function hideNative(el) {
    if (el.dataset.ytproxyHidden === "1") return;
    el.dataset.ytproxyHidden = "1";
    el.style.setProperty("display", "none", "important");
  }

  function restoreNative() {
    document.querySelectorAll("[data-ytproxy-hidden]").forEach((el) => {
      el.style.removeProperty("display");
      delete el.dataset.ytproxyHidden;
    });
  }

  /* ------------------------------------------------------------- our button */

  function buildFromTemplate(html, text) {
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const btn = holder.firstElementChild;
    if (!btn || btn.tagName !== "BUTTON") return null;
    btn.removeAttribute("id");
    btn.disabled = false;
    btn.setAttribute("aria-label", `${text} — YouTube Proxy`);
    const textNode = btn.querySelector(".yt-spec-button-shape-next__button-text-content");
    if (textNode) textNode.textContent = text;
    return btn;
  }

  function buildFallback(text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ytproxy-fallback-btn ${SHAPE_CLASSES}`;
    btn.setAttribute("aria-label", `${text} — YouTube Proxy`);
    const icon = document.createElement("div");
    icon.className = "yt-spec-button-shape-next__icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = ICON_SVG;
    const label = document.createElement("div");
    label.className = "yt-spec-button-shape-next__button-text-content";
    label.textContent = text;
    btn.append(icon, label);
    return btn;
  }

  function setButtonText(btn, text) {
    const node = btn.querySelector(".yt-spec-button-shape-next__button-text-content");
    if (node) node.textContent = text;
    else btn.textContent = text;
  }

  function createButton(text, onClick) {
    const wrap = document.createElement("div");
    wrap.className = "ytproxy-action";
    const template = readTemplate();
    const btn = (template && buildFromTemplate(template, text)) || buildFallback(text);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    wrap.append(btn);
    return { el: wrap, button: btn, destroy: () => wrap.remove() };
  }

  /* --------------------------------------------------------------- quality menu */

  function closeMenu() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
      document.removeEventListener("click", onDocClick, true);
    }
  }

  function onDocClick(ev) {
    if (menuEl && !menuEl.contains(ev.target)) closeMenu();
  }

  function openMenu(anchor, onPick) {
    closeMenu();
    const menu = document.createElement("div");
    menu.className = "ytproxy-menu";
    for (const preset of PRESETS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "ytproxy-menu__item";
      item.textContent = preset.label;
      item.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeMenu();
        onPick(preset.quality);
      });
      menu.append(item);
    }
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
    menu.style.left = `${window.scrollX + rect.left}px`;
    document.body.append(menu);
    menuEl = menu;
    // Capture phase, so a click inside YouTube's own handlers still closes this.
    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  }

  /* ------------------------------------------------------------------ toast */

  let toastTimer = null;
  function toast(message, isError) {
    let el = document.querySelector(".ytproxy-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "ytproxy-toast";
      document.body.append(el);
    }
    el.textContent = message;
    el.classList.toggle("is-error", Boolean(isError));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 4000);
  }

  /* --------------------------------------------------------------- download */

  async function startDownload(btn, quality) {
    const meta = readVideoMeta();
    const original = buttonLabel;
    setButtonText(btn, "שולח…");
    btn.disabled = true;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        payload: { url: meta.url, title: meta.title, quality, mode: "video" }
      });
      if (res && res.ok) {
        toast("ההורדה נשלחה ל-GitHub — אפשר לעקוב בלשונית של התוסף");
        setButtonText(btn, "נשלח ✓");
        setTimeout(() => setButtonText(btn, original), 2500);
      } else {
        toast((res && res.error) || "ההורדה נכשלה", true);
        setButtonText(btn, original);
      }
    } catch {
      // Usually means the extension was reloaded/updated while this page stayed open.
      toast("אין קשר לתוסף — רענן את הדף", true);
      setButtonText(btn, original);
    } finally {
      btn.disabled = false;
    }
  }

  function onActivate(btn) {
    openMenu(btn, (quality) => void startDownload(btn, quality));
  }

  /* -------------------------------------------------------------- lifecycle */

  function ensureWatchButton() {
    const native = findDownloadControl(document.querySelector("ytd-watch-metadata") || document.body);
    if (native) {
      harvestTemplate(native);
      hideNative(native);
    }
    // Also require it to still be *visible*: YouTube sometimes reparents the action bar
    // into a hidden subtree on re-render, which leaves our button connected but not
    // shown — in which case it has to be rebuilt, not left there invisible.
    if (handle && handle.el.isConnected && handle.el.offsetParent !== null) return;
    const container = findActionsContainer();
    if (!container) return; // not rendered yet; the MutationObserver retries
    if (handle) handle.destroy();

    const created = createButton(buttonLabel, onActivate);
    // Sit where the native download button was, or next to Share as a fallback.
    const buttons = labeledButtons(container);
    const dl = buttons.find((el) => matchLabel(el, DOWNLOAD_LABELS));
    const share = buttons.find((el) => matchLabel(el, SHARE_LABELS));
    const ref = dl ? outerAction(dl) : share ? outerAction(share) : null;
    if (ref && ref.parentElement === container) ref.after(created.el);
    else container.append(created.el);
    handle = created;
  }

  function teardown() {
    closeMenu();
    restoreNative();
    if (handle) handle.destroy();
    handle = null;
  }

  function ensureIntegration() {
    if (isWatchPage()) ensureWatchButton();
    else teardown();
  }

  function schedule() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(ensureIntegration, 350);
  }

  const onNav = () => {
    closeMenu();
    schedule();
  };
  window.addEventListener("yt-navigate-finish", onNav);
  document.addEventListener("yt-navigate-finish", onNav);
  // YouTube is a SPA that rebuilds the action bar constantly, so re-assert on any
  // DOM change rather than only on navigation.
  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true });
  // schedule() is a debounce, so a page that mutates faster than the delay could keep
  // resetting it and never actually run. Measured on a real watch page it fires fine,
  // but mutation rates vary with ads/Premium/layout, so this interval guarantees the
  // button still appears regardless of how the debounce happens to land. ensureWatch-
  // Button() returns immediately once the button is present, so this stays cheap.
  setInterval(ensureIntegration, 2000);
  ensureIntegration();
  schedule();
})();
