using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using DocViewer.Web.Models;
using DocViewer.Web.Services;

namespace DocViewer.Web.Controllers;

public class HomeController : Controller
{
    private static readonly string[] SupportedExtensions =
    [
        ".pdf", ".eml", ".msg", ".txt",
        ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp",
        ".docx", ".xlsx", ".doc", ".xls", ".pptx", ".ppt", ".odt", ".ods",
    ];

    private readonly ILogger<HomeController> _logger;
    private readonly IDocumentStore _documentStore;
    private readonly IDocumentConverter _documentConverter;
    private readonly IWebHostEnvironment _environment;
    private readonly IConfiguration _configuration;

    public HomeController(ILogger<HomeController> logger, IDocumentStore documentStore, IDocumentConverter documentConverter, IWebHostEnvironment environment, IConfiguration configuration)
    {
        _logger = logger;
        _documentStore = documentStore;
        _documentConverter = documentConverter;
        _environment = environment;
        _configuration = configuration;
    }

    // Lets a caller open a document by server-side file path directly, e.g.
    // http://host/?file=<path>&key=<shared-secret> - skipping the upload form.
    // In Development this works unconditionally (localhost convenience). Outside
    // Development it requires "key" to match LocalFileAccess:SharedKey, because a
    // query string naming an arbitrary server-side file path is a classic
    // local-file-read vulnerability - the shared key restricts it to whichever
    // internal system is configured to know the secret, not anyone who can guess
    // or enumerate the URL. If the key isn't configured at all, this path is
    // denied outright rather than silently falling open.
    public async Task<IActionResult> Index([FromQuery] string? file, [FromQuery] string? key)
    {
        if (string.IsNullOrWhiteSpace(file))
        {
            return View();
        }

        if (!_environment.IsDevelopment() && !HasValidFileAccessKey(key))
        {
            ModelState.AddModelError(string.Empty, "การเปิดไฟล์ผ่าน query parameter ต้องระบุ key ที่ถูกต้อง");
            return View();
        }

        if (!System.IO.File.Exists(file))
        {
            ModelState.AddModelError(string.Empty, $"ไม่พบไฟล์: {file}");
            return View();
        }

        var extension = Path.GetExtension(file);
        if (!SupportedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
        {
            ModelState.AddModelError(string.Empty, "รองรับเฉพาะไฟล์ PDF, Email (.eml/.msg), รูปภาพ, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), OpenDocument (.odt/.ods) หรือ .txt เท่านั้น");
            return View();
        }

        await using var stream = System.IO.File.OpenRead(file);
        var id = await ProcessDocumentAsync(stream, Path.GetFileName(file), extension);
        return RedirectToAction("Index", "Viewer", new { id });
    }

    [HttpPost]
    [ValidateAntiForgeryToken]
    [RequestSizeLimit(500 * 1024 * 1024)]
    [RequestFormLimits(MultipartBodyLengthLimit = 500 * 1024 * 1024)]
    public async Task<IActionResult> Upload(IFormFile file)
    {
        if (file is null || file.Length == 0)
        {
            ModelState.AddModelError(string.Empty, "กรุณาเลือกไฟล์เอกสารที่ต้องการดู");
            return View(nameof(Index));
        }

        var extension = Path.GetExtension(file.FileName);
        if (!SupportedExtensions.Contains(extension, StringComparer.OrdinalIgnoreCase))
        {
            ModelState.AddModelError(string.Empty, "รองรับเฉพาะไฟล์ PDF, Email (.eml/.msg), รูปภาพ, Word (.doc/.docx), Excel (.xls/.xlsx), PowerPoint (.ppt/.pptx), OpenDocument (.odt/.ods) หรือ .txt เท่านั้น");
            return View(nameof(Index));
        }

        await using var stream = file.OpenReadStream();
        var id = await ProcessDocumentAsync(stream, file.FileName, extension);
        return RedirectToAction("Index", "Viewer", new { id });
    }

    // Constant-time comparison against LocalFileAccess:SharedKey so response timing
    // can't be used to brute-force the key one character at a time.
    private bool HasValidFileAccessKey(string? suppliedKey)
    {
        var configuredKey = _configuration["LocalFileAccess:SharedKey"];
        if (string.IsNullOrEmpty(configuredKey) || string.IsNullOrEmpty(suppliedKey))
        {
            return false;
        }

        var configuredBytes = Encoding.UTF8.GetBytes(configuredKey);
        var suppliedBytes = Encoding.UTF8.GetBytes(suppliedKey);
        return configuredBytes.Length == suppliedBytes.Length
            && CryptographicOperations.FixedTimeEquals(configuredBytes, suppliedBytes);
    }

    private async Task<Guid> ProcessDocumentAsync(Stream stream, string fileName, string extension)
    {
        byte[] pdfBytes;
        if (extension.Equals(".pdf", StringComparison.OrdinalIgnoreCase))
        {
            using var memory = new MemoryStream();
            await stream.CopyToAsync(memory);
            pdfBytes = memory.ToArray();
        }
        else
        {
            pdfBytes = await _documentConverter.ConvertAsync(stream, fileName, HttpContext.RequestAborted);
        }

        return _documentStore.Save(fileName, pdfBytes);
    }

    public IActionResult Privacy()
    {
        return View();
    }

    [ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    public IActionResult Error()
    {
        return View(new ErrorViewModel { RequestId = Activity.Current?.Id ?? HttpContext.TraceIdentifier });
    }
}
