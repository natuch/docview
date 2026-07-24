# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the repo root (`PdfEmailViewer.sln`) or from `src/PdfEmailViewer.Web/`.

```bash
dotnet build                                    # build the solution
dotnet run --project src/PdfEmailViewer.Web     # run locally (port from Properties/launchSettings.json)
```

There is no test project yet.

**Do not run `dotnet clean` / delete `obj`+`bin` and rebuild without first stripping the macOS `com.apple.provenance` xattr from `wwwroot/**`** (`find wwwroot -type f -exec xattr -d com.apple.provenance {} \; 2>/dev/null`). On this SDK (9.0.300) that xattr makes the StaticWebAssets MSBuild task throw `Last write time for '...' is not defined`, which is why `StaticWebAssetsEnabled` is set to `false` in the `.csproj` and `Program.cs` uses classic `app.UseStaticFiles()` instead of `app.MapStaticAssets()`. If a future SDK upgrade fixes the underlying bug, this workaround (and the corresponding `@RenderSectionAsync("Styles")` plumbing in `_Layout.cshtml` used to pull in per-view CSS without asset bundling) can likely be removed.

## Architecture

Single ASP.NET Core MVC project (`net9.0`) that renders PDFs and emails in-browser via PDF.js, with no server-side dependency beyond the initial upload/convert step.

**Flow:** `HomeController.Upload` accepts `.pdf`/`.eml`/`.msg` → non-PDF files go through `IEmailToPdfConverter` → resulting PDF bytes are handed to `IDocumentStore.Save`, which returns an opaque `Guid` → redirect to `/Viewer/{id}`.

- **`IDocumentStore` / `DocumentStore`** — in-memory `ConcurrentDictionary<Guid, DocumentRecord>` (singleton), 2-hour TTL evicted lazily on save/get. The browser never sees a real file path or name, only the `Guid`, and the id becomes worthless once the TTL expires. Swap for a distributed cache (e.g. Redis) if this needs to run behind more than one instance.
- **`IEmailToPdfConverter` / `EmailToPdfConverter`** — converts `.eml` (via MimeKit) or `.msg` (via MsgReader's `Storage.Message`) into a single HTML document (header block of From/To/Cc/Subject/Date + body), resolving `cid:` inline images to base64 data URIs for `.eml`, then rasterizes that HTML to PDF using headless Chromium via PuppeteerSharp (`BrowserFetcher().DownloadAsync()` runs once on first conversion and caches the browser — the first email upload in a fresh environment will be slow while Chromium downloads).
- **`ViewerController`** — `Index` renders the toolbar shell for a given document id; `Stream` serves the raw PDF bytes for `pdf.js` to fetch. The stream endpoint sets `Cache-Control: no-store`, `Content-Disposition: inline` with no filename, and `X-Content-Type-Options: nosniff` — this is a deliberate part of the "no download" requirement, not incidental.
- **`wwwroot/js/viewer.js`** — loads `pdf.js` as an ES module (`wwwroot/lib/pdfjs/pdf.mjs` + `pdf.worker.mjs`, vendored directly from a pdf.js release zip, not npm/libman), fetches the PDF via `fetch()` (not a direct `<a>`/`<embed>` link) into an `ArrayBuffer`, and renders one page at a time to a `<canvas>`. All toolbar chrome (zoom, rotate, page nav) is hand-built here — this intentionally does *not* use pdf.js's bundled `viewer.html`, because that ships its own download/print/open-file buttons that would have to be hidden/patched instead of simply not existing.
- **`wwwroot/js/protect.js`** — best-effort UX deterrents only (blocks right-click, text selection, drag, copy, and Ctrl+S/P/U/C). This is explicitly not real DRM: PDF bytes are reachable via dev tools/network tab by design, since the requirement was UX-level protection, not encryption.
- **`.mjs` content type** — `Program.cs` registers `.mjs` → `text/javascript` on a custom `FileExtensionContentTypeProvider` because the default provider doesn't map it, and browsers refuse to execute an ES module served with the wrong MIME type.

Views follow standard MVC conventions (`Views/{Controller}/{Action}.cshtml`) with one exception: `Viewer/Index.cshtml` injects its own stylesheet via a `Styles` section (`@await RenderSectionAsync("Styles", ...)` was added to `_Layout.cshtml` for this) since the project has no bundler.
