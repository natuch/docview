using System.Text;
using System.Text.RegularExpressions;
using MimeKit;
using MsgReader.Outlook;
using PuppeteerSharp;
using PuppeteerSharp.Media;

namespace PdfEmailViewer.Web.Services;

/// <summary>
/// Converts .eml (MimeKit) and .msg (MsgReader) messages into an HTML rendering of
/// header block + body, then rasterizes that HTML to a paginated PDF via headless
/// Chromium (PuppeteerSharp) so it can flow through the same PDF.js viewer as native PDFs.
/// </summary>
public sealed class EmailToPdfConverter : IEmailToPdfConverter
{
    private static readonly SemaphoreSlim BrowserFetchLock = new(1, 1);
    private static bool _browserReady;

    public async Task<byte[]> ConvertAsync(Stream emailStream, string fileName, CancellationToken cancellationToken = default)
    {
        var html = Path.GetExtension(fileName).Equals(".msg", StringComparison.OrdinalIgnoreCase)
            ? RenderMsg(emailStream)
            : RenderEml(emailStream);

        return await RenderHtmlToPdfAsync(html, cancellationToken);
    }

    private static string RenderEml(Stream stream)
    {
        var message = MimeMessage.Load(stream);

        var body = message.HtmlBody is { Length: > 0 } htmlBody
            ? ResolveInlineImages(htmlBody, message)
            : $"<pre style=\"white-space:pre-wrap;font-family:inherit\">{System.Net.WebUtility.HtmlEncode(message.TextBody ?? string.Empty)}</pre>";

        return BuildDocument(
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

        return BuildDocument(
            subject: message.Subject ?? "(no subject)",
            from: message.Sender?.DisplayName ?? message.Sender?.Email ?? "(unknown sender)",
            to: to,
            cc: string.IsNullOrWhiteSpace(cc) ? null : cc,
            date: message.SentOn?.ToString("f") ?? string.Empty,
            bodyHtml: body);
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

    private static string BuildDocument(string subject, string from, string to, string? cc, string date, string bodyHtml)
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
        await EnsureBrowserAsync(cancellationToken);

        await using var browser = await Puppeteer.LaunchAsync(new LaunchOptions
        {
            Headless = true,
            Args = ["--no-sandbox", "--disable-gpu"],
        });
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
            PrintBackground = true,
            MarginOptions = new MarginOptions { Top = "0", Bottom = "0", Left = "0", Right = "0" },
        });
    }

    private static async Task EnsureBrowserAsync(CancellationToken cancellationToken)
    {
        if (_browserReady)
        {
            return;
        }

        await BrowserFetchLock.WaitAsync(cancellationToken);
        try
        {
            if (_browserReady)
            {
                return;
            }

            var fetcher = new BrowserFetcher();
            await fetcher.DownloadAsync();
            _browserReady = true;
        }
        finally
        {
            BrowserFetchLock.Release();
        }
    }
}
