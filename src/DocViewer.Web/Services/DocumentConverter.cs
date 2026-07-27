using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using MimeKit;
using MsgReader.Outlook;
using NPOI.HSSF.UserModel;
using NPOI.SS.UserModel;
using NPOI.XSSF.UserModel;
using PuppeteerSharp;
using PuppeteerSharp.Media;
using SixLabors.ImageSharp;

namespace DocViewer.Web.Services;

/// <summary>
/// Converts non-PDF documents into a PDF rendering so they can flow through the
/// same PDF.js viewer as native PDFs. Three conversion paths, all producing PDF
/// bytes:
///  - .eml/.msg -&gt; HTML (header block + body) -&gt; headless Chromium print-to-PDF
///  - .txt/images -&gt; a minimal HTML wrapper -&gt; headless Chromium print-to-PDF
///  - .docx/.xlsx -&gt; LibreOffice headless (native, much higher fidelity than
///    re-deriving Office layout by hand)
/// </summary>
public sealed class DocumentConverter : IDocumentConverter
{
    private static readonly string[] ImageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"];
    private static readonly string[] OfficeExtensions = [".docx", ".xlsx", ".doc", ".xls", ".pptx", ".ppt", ".odt", ".ods"];

    // Guards lazy one-time browser download/launch; the browser instance itself
    // is then reused (one Page per request) rather than launching a fresh
    // Chromium process per conversion, so many concurrent conversions don't
    // spawn many concurrent browser processes.
    private static readonly SemaphoreSlim BrowserInitLock = new(1, 1);
    private static IBrowser? _browser;

    public async Task<byte[]> ConvertAsync(Stream sourceStream, string fileName, CancellationToken cancellationToken = default)
    {
        var extension = Path.GetExtension(fileName);

        if (OfficeExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
        {
            return await ConvertOfficeDocumentAsync(sourceStream, extension, cancellationToken);
        }

        var html = extension switch
        {
            _ when extension.Equals(".msg", StringComparison.OrdinalIgnoreCase) => RenderMsg(sourceStream),
            _ when extension.Equals(".eml", StringComparison.OrdinalIgnoreCase) => RenderEml(sourceStream),
            _ when extension.Equals(".txt", StringComparison.OrdinalIgnoreCase) => await RenderTextAsync(sourceStream, cancellationToken),
            _ when ImageExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase) => await RenderImageAsync(sourceStream, cancellationToken),
            _ => throw new NotSupportedException($"Unsupported file type: {extension}"),
        };

        return await RenderHtmlToPdfAsync(html, cancellationToken);
    }

    private static string RenderEml(Stream stream)
    {
        var message = MimeMessage.Load(stream);

        var body = message.HtmlBody is { Length: > 0 } htmlBody
            ? ResolveInlineImages(htmlBody, message)
            : $"<pre style=\"white-space:pre-wrap;font-family:inherit\">{System.Net.WebUtility.HtmlEncode(message.TextBody ?? string.Empty)}</pre>";

        return BuildEmailDocument(
            subject: message.Subject ?? "(no subject)",
            from: message.From.ToString(),
            to: message.To.ToString(),
            cc: message.Cc.Count > 0 ? message.Cc.ToString() : null,
            date: message.Date.ToString("f"),
            bodyHtml: body);
    }

    private static string RenderMsg(Stream stream)
    {
        using var message = new Storage.Message(stream);

        var body = message.BodyHtml is { Length: > 0 } htmlBody
            ? htmlBody
            : $"<pre style=\"white-space:pre-wrap;font-family:inherit\">{System.Net.WebUtility.HtmlEncode(message.BodyText ?? string.Empty)}</pre>";

        var to = string.Join("; ", message.Recipients
            .Where(r => r.Type == RecipientType.To)
            .Select(r => r.DisplayName));
        var cc = string.Join("; ", message.Recipients
            .Where(r => r.Type == RecipientType.Cc)
            .Select(r => r.DisplayName));

        return BuildEmailDocument(
            subject: message.Subject ?? "(no subject)",
            from: message.Sender?.DisplayName ?? message.Sender?.Email ?? "(unknown sender)",
            to: to,
            cc: string.IsNullOrWhiteSpace(cc) ? null : cc,
            date: message.SentOn?.ToString("f") ?? string.Empty,
            bodyHtml: body);
    }

    private static async Task<string> RenderTextAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(stream);
        var text = await reader.ReadToEndAsync(cancellationToken);

        return "<!doctype html><html><head><meta charset=\"utf-8\"/><style>"
            + "body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#111;margin:0;padding:24px;}"
            + "pre{white-space:pre-wrap;word-break:break-word;margin:0;}"
            + "</style></head><body><pre>"
            + System.Net.WebUtility.HtmlEncode(text)
            + "</pre></body></html>";
    }

    private static async Task<string> RenderImageAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory, cancellationToken);
        var bytes = memory.ToArray();

        var info = Image.Identify(bytes);
        var width = info?.Width ?? 800;
        var height = info?.Height ?? 600;

        var base64 = Convert.ToBase64String(bytes);
        var mimeType = info?.Metadata.DecodedImageFormat?.DefaultMimeType ?? "image/png";

        // @page sized to the image's own pixel dimensions (treated 1:1 as CSS
        // px) gives a single-page PDF with no letterboxing/scaling, so zoom in
        // the viewer reflects the source image's actual resolution.
        return "<!doctype html><html><head><meta charset=\"utf-8\"/><style>"
            + $"@page {{ size: {width}px {height}px; margin: 0; }}"
            + "html,body{margin:0;padding:0;}"
            + $"img{{display:block;width:{width}px;height:{height}px;}}"
            + "</style></head><body>"
            + $"<img src=\"data:{mimeType};base64,{base64}\" />"
            + "</body></html>";
    }

    private static string ResolveInlineImages(string html, MimeMessage message)
    {
        return Regex.Replace(html, "cid:([^\"')]+)", match =>
        {
            var contentId = match.Groups[1].Value;
            var part = message.BodyParts.OfType<MimePart>()
                .FirstOrDefault(p => p.ContentId?.Trim('<', '>') == contentId);

            if (part?.Content is null)
            {
                return match.Value;
            }

            using var memory = new MemoryStream();
            part.Content.DecodeTo(memory);
            var base64 = Convert.ToBase64String(memory.ToArray());
            return $"data:{part.ContentType.MimeType};base64,{base64}";
        });
    }

    private static string BuildEmailDocument(string subject, string from, string to, string? cc, string date, string bodyHtml)
    {
        var sb = new StringBuilder();
        sb.Append("<!doctype html><html><head><meta charset=\"utf-8\"/><style>")
          .Append("body{font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#111;margin:0;padding:24px;}")
          .Append(".header{border-bottom:2px solid #444;padding-bottom:12px;margin-bottom:20px;}")
          .Append(".header h1{font-size:18px;margin:0 0 10px;}")
          .Append(".header .row{margin:2px 0;}")
          .Append(".header .label{display:inline-block;width:60px;color:#555;font-weight:600;}")
          .Append(".body img{max-width:100%;}")
          .Append("</style></head><body>")
          .Append("<div class=\"header\">")
          .Append($"<h1>{System.Net.WebUtility.HtmlEncode(subject)}</h1>")
          .Append($"<div class=\"row\"><span class=\"label\">From:</span>{System.Net.WebUtility.HtmlEncode(from)}</div>")
          .Append($"<div class=\"row\"><span class=\"label\">To:</span>{System.Net.WebUtility.HtmlEncode(to)}</div>");

        if (!string.IsNullOrWhiteSpace(cc))
        {
            sb.Append($"<div class=\"row\"><span class=\"label\">Cc:</span>{System.Net.WebUtility.HtmlEncode(cc)}</div>");
        }

        sb.Append($"<div class=\"row\"><span class=\"label\">Date:</span>{System.Net.WebUtility.HtmlEncode(date)}</div>")
          .Append("</div>")
          .Append($"<div class=\"body\">{bodyHtml}</div>")
          .Append("</body></html>");

        return sb.ToString();
    }

    private static async Task<byte[]> RenderHtmlToPdfAsync(string html, CancellationToken cancellationToken)
    {
        var browser = await GetBrowserAsync(cancellationToken);

        await using var page = await browser.NewPageAsync();
        // Print output re-rasterizes embedded bitmaps (photos, signatures) at the
        // page's device pixel ratio - render at 2x so those images keep their
        // original sharpness instead of being flattened at 1x screen resolution.
        // Vector text is unaffected either way.
        await page.SetViewportAsync(new ViewPortOptions { Width = 800, Height = 1000, DeviceScaleFactor = 2 });
        await page.SetContentAsync(html, new SetContentOptions { WaitUntil = [WaitUntilNavigation.Load] });

        return await page.PdfDataAsync(new PdfOptions
        {
            Format = PaperFormat.A4,
            PreferCSSPageSize = true, // lets image conversion's @page size win over Format above
            PrintBackground = true,
            MarginOptions = new MarginOptions { Top = "0", Bottom = "0", Left = "0", Right = "0" },
        });
    }

    private static async Task<IBrowser> GetBrowserAsync(CancellationToken cancellationToken)
    {
        if (_browser is { IsConnected: true })
        {
            return _browser;
        }

        await BrowserInitLock.WaitAsync(cancellationToken);
        try
        {
            if (_browser is { IsConnected: true })
            {
                return _browser;
            }

            var fetcher = new BrowserFetcher();
            await fetcher.DownloadAsync();

            _browser = await Puppeteer.LaunchAsync(new LaunchOptions
            {
                Headless = true,
                Args = ["--no-sandbox", "--disable-gpu"],
            });
            return _browser;
        }
        finally
        {
            BrowserInitLock.Release();
        }
    }

    private static async Task<byte[]> ConvertOfficeDocumentAsync(Stream sourceStream, string extension, CancellationToken cancellationToken)
    {
        var sofficePath = FindSofficeExecutable()
            ?? throw new InvalidOperationException("LibreOffice (soffice) was not found - install it to preview Office documents.");

        // Fully isolated per-conversion: its own input/output directory *and*
        // its own LibreOffice user-profile directory. Concurrent conversions
        // sharing a profile directory contend for the same lock file and fail
        // outright, so every request gets its own.
        var workDir = Path.Combine(Path.GetTempPath(), $"docviewer-lo-{Guid.NewGuid():N}");
        var profileDir = Path.Combine(workDir, "profile");
        var outDir = Path.Combine(workDir, "out");
        Directory.CreateDirectory(profileDir);
        Directory.CreateDirectory(outDir);

        try
        {
            var inputPath = Path.Combine(workDir, $"input{extension}");

            if (extension.Equals(".xlsx", StringComparison.OrdinalIgnoreCase) ||
                extension.Equals(".xls", StringComparison.OrdinalIgnoreCase))
            {
                var fitToWidthBytes = await FitSpreadsheetToPageWidthAsync(sourceStream, extension, cancellationToken);
                await File.WriteAllBytesAsync(inputPath, fitToWidthBytes, cancellationToken);
            }
            else
            {
                await using var fileStream = File.Create(inputPath);
                await sourceStream.CopyToAsync(fileStream, cancellationToken);
            }

            var startInfo = new ProcessStartInfo
            {
                FileName = sofficePath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            startInfo.ArgumentList.Add("--headless");
            startInfo.ArgumentList.Add("--nologo");
            startInfo.ArgumentList.Add("--nofirststartwizard");
            startInfo.ArgumentList.Add($"-env:UserInstallation=file://{profileDir}");
            startInfo.ArgumentList.Add("--convert-to");
            startInfo.ArgumentList.Add("pdf");
            startInfo.ArgumentList.Add("--outdir");
            startInfo.ArgumentList.Add(outDir);
            startInfo.ArgumentList.Add(inputPath);

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("Failed to start LibreOffice.");

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(300));
            await process.WaitForExitAsync(timeoutCts.Token);

            var outputPath = Path.Combine(outDir, "input.pdf");
            if (process.ExitCode != 0 || !File.Exists(outputPath))
            {
                var stderr = await process.StandardError.ReadToEndAsync(cancellationToken);
                throw new InvalidOperationException($"LibreOffice conversion failed (exit {process.ExitCode}): {stderr}");
            }

            return await File.ReadAllBytesAsync(outputPath, cancellationToken);
        }
        finally
        {
            try
            {
                Directory.Delete(workDir, recursive: true);
            }
            catch
            {
                // Best-effort cleanup - a leftover temp dir isn't worth failing the request over.
            }
        }
    }

    // LibreOffice's headless PDF export honors whatever print/page-setup is stored in the
    // workbook. A spreadsheet with many columns and no "fit to page width" setting - the
    // common case, since Excel's own on-screen grid view never paginates - gets tiled across
    // multiple pages column-wise. Forcing fit-to-width (unbounded height, so only column count
    // affects pagination) here makes the LibreOffice export match what a user actually sees
    // when they open the file in Excel.
    private static async Task<byte[]> FitSpreadsheetToPageWidthAsync(Stream sourceStream, string extension, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        await sourceStream.CopyToAsync(buffer, cancellationToken);
        buffer.Position = 0;

        IWorkbook workbook = extension.Equals(".xlsx", StringComparison.OrdinalIgnoreCase)
            ? new XSSFWorkbook(buffer)
            : new HSSFWorkbook(buffer);

        for (var i = 0; i < workbook.NumberOfSheets; i++)
        {
            var sheet = workbook.GetSheetAt(i);
            sheet.FitToPage = true;
            sheet.PrintSetup.FitWidth = 1;
            sheet.PrintSetup.FitHeight = 0;
            sheet.PrintSetup.Landscape = true;
        }

        using var output = new MemoryStream();
        workbook.Write(output, leaveOpen: true);
        return output.ToArray();
    }

    private static string? FindSofficeExecutable()
    {
        string[] candidates =
        [
            "/Applications/LibreOffice.app/Contents/MacOS/soffice", // macOS
            "/usr/bin/soffice", // most Linux distros
            "/usr/lib/libreoffice/program/soffice", // some Linux distros
        ];

        foreach (var candidate in candidates)
        {
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }

        // Fall back to whatever "soffice" resolves to on PATH.
        return "soffice";
    }
}
