using System.Collections.Concurrent;
using DocViewer.Web.Models;

namespace DocViewer.Web.Services;

/// <summary>
/// In-memory document registry keyed by an opaque id, so the browser never
/// sees a real file path or name it could use to construct a download URL.
/// Suitable for a single-instance demo; swap for a distributed cache (Redis)
/// behind a load balancer.
/// The 30-minute TTL is a fallback only (crashed tab, browser killed before the
/// unload beacon fires) - the normal path is an explicit <see cref="Remove"/>
/// fired by the viewer when the user navigates away, see ViewerController.Release.
/// </summary>
public sealed class DocumentStore : IDocumentStore
{
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);

    // Pressing refresh on the viewer fires the exact same "pagehide" event as
    // actually closing the tab, so viewer.js's unload beacon can't tell the two
    // apart. Remove() doesn't delete outright - it starts this grace window; if
    // the reloaded page's own request for the same document (Viewer/Index or the
    // stream fetch) arrives before it elapses, that counts as "still in use" and
    // the release is cancelled in Get(). Only if nothing asks for it in time is it
    // actually gone - a real tab close never triggers a follow-up request.
    private static readonly TimeSpan ReleaseGrace = TimeSpan.FromSeconds(15);

    private readonly ConcurrentDictionary<Guid, DocumentRecord> _documents = new();

    public Guid Save(string displayName, byte[] pdfBytes)
    {
        EvictExpired();

        var id = Guid.NewGuid();
        _documents[id] = new DocumentRecord
        {
            Id = id,
            DisplayName = displayName,
            PdfBytes = pdfBytes,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        return id;
    }

    public DocumentRecord? Get(Guid id)
    {
        if (!_documents.TryGetValue(id, out var record))
        {
            return null;
        }

        var now = DateTimeOffset.UtcNow;
        if (now - record.CreatedAt >= Ttl)
        {
            _documents.TryRemove(id, out _);
            return null;
        }

        if (record.ReleaseRequestedAt is { } releasedAt)
        {
            if (now - releasedAt >= ReleaseGrace)
            {
                _documents.TryRemove(id, out _);
                return null;
            }

            // Something asked for this document again within the grace window -
            // the release was a refresh, not a real close. Cancel it.
            record.ReleaseRequestedAt = null;
        }

        return record;
    }

    public void Remove(Guid id)
    {
        if (_documents.TryGetValue(id, out var record))
        {
            record.ReleaseRequestedAt = DateTimeOffset.UtcNow;
        }
    }

    private void EvictExpired()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (id, record) in _documents)
        {
            var expired = now - record.CreatedAt >= Ttl;
            var released = record.ReleaseRequestedAt is { } releasedAt && now - releasedAt >= ReleaseGrace;
            if (expired || released)
            {
                _documents.TryRemove(id, out _);
            }
        }
    }
}
