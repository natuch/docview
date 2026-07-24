namespace PdfEmailViewer.Web.Services;

public interface IEmailToPdfConverter
{
    /// <summary>Converts a .eml or .msg message into a paginated PDF rendering of its headers + body.</summary>
    Task<byte[]> ConvertAsync(Stream emailStream, string fileName, CancellationToken cancellationToken = default);
}
