using System.Text;
using Microsoft.AspNetCore.StaticFiles;
using PdfEmailViewer.Web.Services;

// .NET Core only ships Unicode/ASCII encodings by default - legacy codepages
// (Windows-874/Thai, Windows-1252, Shift-JIS, ...) used in .eml/.msg headers
// need this provider registered, or Encoding.GetEncoding(874) throws.
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddControllersWithViews();
builder.Services.AddSingleton<IDocumentStore, DocumentStore>();
builder.Services.AddSingleton<IEmailToPdfConverter, EmailToPdfConverter>();

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
