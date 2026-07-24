// UX-level deterrents only — a determined user with dev tools can still get at
// pixels or the network response. This raises the bar for casual copy/save,
// it is not DRM.
(function () {
    const scope = document.getElementById("viewer-root");
    if (!scope) return;

    scope.addEventListener("contextmenu", (e) => e.preventDefault());
    scope.addEventListener("selectstart", (e) => e.preventDefault());
    scope.addEventListener("dragstart", (e) => e.preventDefault());
    scope.addEventListener("copy", (e) => e.preventDefault());

    document.addEventListener("keydown", (e) => {
        const key = e.key.toLowerCase();
        const blockedCombo = (e.ctrlKey || e.metaKey) && ["s", "p", "u", "c"].includes(key);
        if (blockedCombo || key === "printscreen") {
            e.preventDefault();
        }
    });
})();
