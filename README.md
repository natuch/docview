# DocViewer

A web-based document viewer built with ASP.NET Core MVC and PDF.js. Upload a PDF, email (`.eml`/`.msg`), image, Office document (Word/Excel/PowerPoint/OpenDocument), or `.txt` file and view it in the browser through a custom toolbar — zoom in/out, rotate, page navigation, text highlighting — without a download button, right-click, or copy.

## Features

- **PDF viewing** via [PDF.js](https://mozilla.github.io/pdf.js/), rendered to `<canvas>` + a text layer (for highlighting) + a link layer (real link annotations and plain-text URLs the source didn't mark as links), with a hand-built toolbar (no bundled `viewer.html`, so there's no built-in download/print/open-file UI to hide).
- **Multi-format preview** — anything that isn't already a PDF is converted to one first, then flows through the same viewer:
  - `.eml`/`.msg` → header block + body HTML → headless Chromium print-to-PDF
  - `.txt` and images (`.jpg`/`.png`/`.gif`/`.bmp`/`.webp`) → a minimal HTML wrapper → headless Chromium print-to-PDF (images render at their native pixel size, no letterboxing)
  - `.docx`/`.xlsx`/`.doc`/`.xls`/`.pptx`/`.ppt`/`.odt`/`.ods` → [LibreOffice](https://www.libreoffice.org/) headless conversion (must be installed separately — see Requirements)
- **Concurrency-safe conversions** — the headless Chromium browser is a single shared instance reused across requests (one isolated Page per conversion, not one browser process per conversion), and every LibreOffice conversion gets its own temp working directory and user-profile directory, so many people converting the same or different files at once don't collide or block each other.
- **No download / no copy (UX-level)** — the PDF stream is served with `Cache-Control: no-store` and an `inline` disposition with no filename, and the viewer blocks right-click, drag, and common save/print shortcuts. Text can be highlighted/selected in the text layer, but copy is still blocked. This is a UX deterrent, not DRM — the PDF bytes are still reachable via dev tools/network tab by design.
- **Password-protected PDFs** — prompts for a password in-page (wrong-password retry, cancel) instead of failing.
- **Open a local file directly** — `http://localhost:5202/?file=<absolute-path>` skips the upload form entirely. **Development-only**: letting a query string name an arbitrary server-side file path is a classic local-file-read vulnerability if this were ever exposed beyond localhost, so it's disabled outside `IsDevelopment()`.

## Requirements

- [.NET 9 SDK](https://dotnet.microsoft.com/download)
- Network access on first email/image/txt upload, so PuppeteerSharp can download headless Chromium (cached afterwards)
- [LibreOffice](https://www.libreoffice.org/) installed, for Office document (`.docx`/`.xlsx`/etc.) previews — looked for at `/Applications/LibreOffice.app/Contents/MacOS/soffice` (macOS), `/usr/bin/soffice` or `/usr/lib/libreoffice/program/soffice` (Linux), `C:\Program Files\LibreOffice\program\soffice.exe` or the `(x86)` equivalent (Windows), falling back to `soffice` on `PATH`

## Deploying to IIS (Windows)

1. Install the [.NET 9 Hosting Bundle](https://dotnet.microsoft.com/download) on the server (not just the SDK/runtime) so IIS can load the ASP.NET Core Module.
2. Install LibreOffice on the server at one of the paths listed above.
3. `dotnet publish src/DocViewer.Web -c Release -o <publish-folder>` and point an IIS site/application at `<publish-folder>`. The project's `web.config` is used as the publish template (IIS launcher settings get filled in automatically) and already raises IIS's own upload cap to 500 MB and maps `.mjs` to `text/javascript` — both needed on top of Kestrel-level settings, since IIS's request-filtering and static-file modules sit in front of the app and enforce their own defaults regardless of what the app itself allows.
4. Make sure the app pool identity can spawn child processes (`soffice.exe`) and write to its temp directory; enabling "Load User Profile" on the app pool avoids some Puppeteer/Chromium first-run issues.
5. First request that needs email/image/txt conversion downloads headless Chromium via PuppeteerSharp — make sure the server has (temporary, first-run) outbound network access, or pre-warm the Chromium cache as part of the deployment.

## Getting started

```bash
dotnet build
dotnet run --project src/DocViewer.Web
```

Then open the URL shown in the console (see `src/DocViewer.Web/Properties/launchSettings.json`) and upload a file from the home page, or jump straight to one with `?file=<absolute-path>` (dev only, see above).

## Project layout

```
src/DocViewer.Web/
├── Controllers/     HomeController (upload + ?file= dev shortcut), ViewerController (viewer shell + PDF stream)
├── Services/        IDocumentStore (in-memory, TTL'd registry), IDocumentConverter (email/image/text/Office → PDF)
├── Views/           Home/Viewer Razor views
└── wwwroot/
    ├── js/          viewer.js (PDF.js + toolbar + text/link layers), protect.js (UX deterrents)
    └── lib/pdfjs/   vendored pdf.js build (pdf.mjs + pdf.worker.mjs)
```

See [CLAUDE.md](./CLAUDE.md) for a deeper architecture walkthrough and known SDK workarounds.

## Notes

- Documents are kept in an in-memory store keyed by an opaque id with a 2-hour TTL — nothing is written to disk, and the store is per-instance (swap for a distributed cache like Redis if running more than one instance).
- There is no authentication yet — anyone with a live document id can view it.
- For a real production deployment, replace the `?file=` local-path shortcut with either a server-to-server upload API (push bytes, get back a document id/URL) or a signed-URL fetch — see the discussion in project history for the tradeoffs.
