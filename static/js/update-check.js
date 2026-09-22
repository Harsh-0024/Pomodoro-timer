// Shows a quiet "new version" link in the footer. Only bundled (.zip) copies
// ever get one — git installs update themselves. Silent on any failure.
(function () {
  const slot = document.getElementById("updateNotice");
  if (!slot) return;
  fetch("/api/version", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d || !d.update_available) return;
      const link = document.createElement("a");
      link.href = d.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "foot-update";
      link.textContent = `Version ${d.latest} is available — download`;
      slot.appendChild(link);
    })
    .catch(() => {});
})();
