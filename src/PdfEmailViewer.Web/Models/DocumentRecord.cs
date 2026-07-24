namespace PdfEmailViewer.Web.Models;

public sealed class DocumentRecord
{
    public required Guid Id { get; init; }
    public required string DisplayName { get; init; }
    public required byte[] PdfBytes { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}
