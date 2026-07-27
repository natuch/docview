// UX-level deterrents only — a determined user with dev tools can still get at
// pixels or the network response. This raises the bar for casual copy/save,
// it is not DRM.
(function () {
    const scope = document.getElementById("viewer-root");
    if (!scope) return;

    // e.target can be a non-Element (e.g. a Text node) here, which has no
    // .closest() - fall back to its parent element.
    const targetElement = (e) => (e.target instanceof Element ? e.target : e.target?.parentElement) ?? null;
    // The password dialog is a normal input field, not document content -
    // it should behave like any other form (select/copy/paste/right-click
    // all work normally there), unlike the rest of the viewer.
    const isExempt = (target) => !!target?.closest(".password-dialog");

    scope.addEventListener("contextmenu", (e) => {
        if (!isExempt(targetElement(e))) e.preventDefault();
    });
    // Text highlighting is intentionally allowed inside the PDF text layer;
    // everywhere else (toolbar, thumbnails) stays non-selectable.
    scope.addEventListener("selectstart", (e) => {
        const target = targetElement(e);
        if (!target || (!target.closest(".textLayer") && !isExempt(target))) e.preventDefault();
    });
    scope.addEventListener("dragstart", (e) => e.preventDefault());
    scope.addEventListener("copy", (e) => {
        if (!isExempt(targetElement(e))) e.preventDefault();
    });

    document.addEventListener("keydown", (e) => {
        if (isExempt(targetElement(e))) return;

        const key = e.key.toLowerCase();
        const blockedCombo = (e.ctrlKey || e.metaKey) && ["s", "p", "u", "c"].includes(key);
        if (blockedCombo || key === "printscreen") {
            e.preventDefault();
        }
    });
})();
