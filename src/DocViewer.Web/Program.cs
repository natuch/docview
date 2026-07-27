using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.StaticFiles;
using DocViewer.Web.Services;

// .NET Core only ships Unicode/ASCII encodings by default - legacy codepages
// (Windows-874/Thai, Windows-1252, Shift-JIS, ...) used in .eml/.msg headers
// need this provider registered, or Encoding.GetEncoding(874) throws.
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllersWithViews();
builder.Services.AddSingleton<IDocumentStore, DocumentStore>();
builder.Services.AddSingleton<IDocumentConverter, DocumentConverter>();

// Under IIS with the default ApplicationPoolIdentity (no loaded user profile), Data
// Protection falls back to C:\WINDOWS\system32\config\systemprofile\... for its key
// ring, which the app pool identity can't write to - every antiforgery token
// generation (i.e. every page with the upload <form>) then throws. Pinning an
// explicit, app-owned key folder sidesteps the profile lookup entirely; grant the
// app pool identity (or IIS_IUSRS) write access to this folder on the server.
builder.Services.AddDataProtection()
    .PersistKeysToFileSystem(new DirectoryInfo(Path.Combine(builder.Environment.ContentRootPath, "keys")))
    .SetApplicationName("DocViewer");

var app = builder.Build();

// Configure the HTTP request pipeline.
if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Home/Error");
    // The default HSTS value is 30 days. You may want to change this for production scenarios, see https://aka.ms/aspnetcore-hsts.
    app.UseHsts();
}

var contentTypeProvider = new FileExtensionContentTypeProvider();
contentTypeProvider.Mappings[".mjs"] = "text/javascript";

app.UseHttpsRedirection();
app.UseStaticFiles(new StaticFileOptions { ContentTypeProvider = contentTypeProvider });
app.UseRouting();

app.UseAuthorization();

app.MapControllerRoute(
    name: "default",
    pattern: "{controller=Home}/{action=Index}/{id?}");

app.Run();
