"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const FIELDS = ["owner", "repo", "workflow", "ref", "token", "cookieKey"];

  const connDot = $("conn-dot");
  const connText = $("conn-text");
  const msg = $("msg");
  const toast = $("toast");

  let toastTimer = null;
  function showToast(text) {
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 2200);
  }

  function showMsg(text, ok) {
    msg.textContent = text;
    msg.hidden = false;
    msg.classList.toggle("is-ok", Boolean(ok));
    msg.classList.toggle("is-fail", !ok);
  }

  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }

  async function load() {
    const cfg = await send({ type: "GET_CONFIG" });
    if (!cfg) return;
    for (const field of FIELDS) $(field).value = cfg[field] || "";
    $("version").textContent = `גרסה ${chrome.runtime.getManifest().version}`;
  }

  function validate() {
    const cookieKey = $("cookieKey").value.trim();
    if (cookieKey && !/^[0-9a-fA-F]{64}$/.test(cookieKey)) {
      return "COOKIE_KEY חייב להיות בדיוק 64 תווי hex";
    }
    if (!$("owner").value.trim() || !$("repo").value.trim()) return "חסרים owner/repo";
    return null;
  }

  $("save").addEventListener("click", async () => {
    const problem = validate();
    if (problem) {
      showMsg(problem, false);
      return;
    }
    const patch = {};
    for (const field of FIELDS) patch[field] = $(field).value.trim();
    await send({ type: "SET_CONFIG", patch });
    showMsg("ההגדרות נשמרו", true);
    showToast("נשמר");
  });

  $("reset").addEventListener("click", async () => {
    await send({ type: "RESET_CONFIG" });
    await load();
    showMsg("אופס לברירות המחדל", true);
  });

  $("recheck").addEventListener("click", async () => {
    connDot.className = "dot";
    connText.textContent = "בודק…";
    const res = await send({ type: "TEST_CONNECTION" });
    if (res && res.ok) {
      connDot.classList.add("is-ok");
      connText.textContent = `מחובר · ${res.detail}`;
    } else {
      connDot.classList.add("is-fail");
      connText.textContent = (res && res.error) || "החיבור נכשל";
    }
  });

  void load();
})();
