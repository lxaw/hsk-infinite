"use strict";
// Tells the local server this page is open. Started with --auto-exit (as HSK Exams.app does), the server
// stops by itself shortly after the last page is closed, so closing the browser is enough to quit.
(function () {
  const id = Math.random().toString(36).slice(2, 10);
  const ping = () => fetch(`/api/ping?c=${id}`, { cache: "no-store" }).catch(() => {});
  ping();
  setInterval(ping, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) ping(); });
  window.addEventListener("pageshow", (e) => { if (e.persisted) ping(); });  // back from the back/forward cache
  window.addEventListener("pagehide", () => navigator.sendBeacon(`/api/bye?c=${id}`));
})();
