using System.Security.Cryptography;

namespace Raikasa.Core.Migration;

/// <summary>The file operations the folder move needs, so tests can make one of them fail.</summary>
internal interface IFolderOperations
{
    /// <summary>Renames a folder. On one volume this happens whole or not at all.</summary>
    void MoveDirectory(string source, string destination);

    /// <summary>Copies a file's bytes over <paramref name="destination"/> and flushes them to disk.</summary>
    void CopyFile(string source, string destination);
}

internal sealed class FolderOperations : IFolderOperations
{
    public static readonly FolderOperations Default = new();

    public void MoveDirectory(string source, string destination) => Directory.Move(source, destination);

    public void CopyFile(string source, string destination)
    {
        File.Copy(source, destination, overwrite: true);
        using var stream = new FileStream(destination, FileMode.Open, FileAccess.Write, FileShare.None);
        stream.Flush(flushToDisk: true);
    }
}

/// <summary>
/// Moves a per-user data folder to a new name. The folder is renamed when the new one does not exist yet; otherwise,
/// or when the rename fails, the missing files are copied, every file is verified by length and hash, and only then
/// are the old files removed. A run that stopped part way is continued by the next one.
/// </summary>
internal static class DataFolderMove
{
    /// <summary>A copy is written under this suffix first, so a copy cut short is never under the file's own name.</summary>
    internal static readonly string PartialSuffix = $".{ProductInfo.Id}-partial";

    /// <returns><see langword="true"/> when the old folder is gone: moved now, earlier, or never there.</returns>
    public static bool Run(string oldRoot, string newRoot, IFolderOperations files)
    {
        try
        {
            return Move(oldRoot, newRoot, files);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // What is done stays done, and the next start continues from there.
            return false;
        }
    }

    /// <summary>
    /// Deletes a folder and everything below it, for the uninstaller. A link (junction, symbolic link, mount point) is
    /// never followed or deleted, and the folders that hold one stay.
    /// </summary>
    /// <returns><see langword="true"/> when the folder is gone.</returns>
    public static bool RemoveTree(string root)
    {
        try
        {
            if (!TryGetAttributes(root, out var attributes))
                return true;
            return !IsLinkOrFile(attributes) && RemoveContents(new DirectoryInfo(root)) && TryDelete(new DirectoryInfo(root));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool Move(string oldRoot, string newRoot, IFolderOperations files)
    {
        if (!TryGetAttributes(oldRoot, out var oldAttributes))
            return true;
        if (IsLinkOrFile(oldAttributes) || List(oldRoot) is not { } old)
            return false;

        var newExists = TryGetAttributes(newRoot, out var newAttributes);
        if (newExists && (IsLinkOrFile(newAttributes) || List(newRoot) is null))
            return false;

        if (!newExists)
        {
            try
            {
                files.MoveDirectory(oldRoot, newRoot);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A rename happens whole or not at all, so the old folder is as it was: copy it instead.
            }
        }

        // Copy what the new folder lacks. A file it already has wins: an earlier run's copy, or the app's own.
        var copied = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        Directory.CreateDirectory(newRoot);
        foreach (var directory in old.Directories)
            Directory.CreateDirectory(Path.Combine(newRoot, directory));
        foreach (var file in old.Files)
        {
            var target = Path.Combine(newRoot, file);
            if (Path.Exists(target))
                continue;
            try
            {
                files.CopyFile(Path.Combine(oldRoot, file), target + PartialSuffix);
                File.Move(target + PartialSuffix, target);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                File.Delete(target + PartialSuffix);
                throw;
            }
            copied.Add(file);
        }

        // Every old file must have an identical copy before anything old is removed.
        var verified = List(newRoot) is not null;
        foreach (var file in old.Files)
        {
            if (SameContent(Path.Combine(oldRoot, file), Path.Combine(newRoot, file)))
                continue;
            verified = false;
            // A copy of ours that doesn't match isn't kept, so the next start copies the file again.
            if (copied.Contains(file))
                File.Delete(Path.Combine(newRoot, file));
        }
        if (!verified || List(oldRoot) is null)
            return false;

        // Only the verified files, then the folders they leave empty: a file that appeared since stays for the next start.
        foreach (var file in old.Files)
            File.Delete(Path.Combine(oldRoot, file));
        foreach (var directory in Enumerable.Reverse(old.Directories))
            TryDeleteEmpty(Path.Combine(oldRoot, directory));
        TryDeleteEmpty(oldRoot);
        return !Path.Exists(oldRoot);
    }

    private sealed record Tree(List<string> Directories, List<string> Files);

    /// <summary>
    /// Every folder and file below <paramref name="root"/>, relative to it, each folder before what it holds; or
    /// <see langword="null"/> when a link is anywhere in it.
    /// </summary>
    private static Tree? List(string root)
    {
        var tree = new Tree([], []);
        return Walk(new DirectoryInfo(root)) ? tree : null;

        bool Walk(DirectoryInfo directory)
        {
            foreach (var entry in directory.EnumerateFileSystemInfos())
            {
                if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                    return false;
                var relative = Path.GetRelativePath(root, entry.FullName);
                if (entry is DirectoryInfo subdirectory)
                {
                    tree.Directories.Add(relative);
                    if (!Walk(subdirectory))
                        return false;
                }
                else
                    tree.Files.Add(relative);
            }
            return true;
        }
    }

    private static bool SameContent(string source, string target)
    {
        if (!File.Exists(target))
            return false;
        using var original = File.OpenRead(source);
        using var copy = File.OpenRead(target);
        return original.Length == copy.Length && SHA256.HashData(original).AsSpan().SequenceEqual(SHA256.HashData(copy));
    }

    private static bool RemoveContents(DirectoryInfo directory)
    {
        var removed = true;
        foreach (var entry in directory.EnumerateFileSystemInfos().ToList())
        {
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                removed = false;
            else if (entry is DirectoryInfo subdirectory)
                removed &= RemoveContents(subdirectory) && TryDelete(subdirectory);
            else
                removed &= TryDelete(entry);
        }
        return removed;
    }

    private static void TryDeleteEmpty(string directory)
    {
        if (TryGetAttributes(directory, out var attributes) && !IsLinkOrFile(attributes) && !Directory.EnumerateFileSystemEntries(directory).Any())
            TryDelete(new DirectoryInfo(directory));
    }

    /// <summary>Deletes one file, or one empty folder.</summary>
    private static bool TryDelete(FileSystemInfo entry)
    {
        try
        {
            entry.Delete();
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsLinkOrFile(FileAttributes attributes) =>
        attributes.HasFlag(FileAttributes.ReparsePoint) || !attributes.HasFlag(FileAttributes.Directory);

    private static bool TryGetAttributes(string path, out FileAttributes attributes)
    {
        try
        {
            attributes = File.GetAttributes(path);
            return true;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            attributes = default;
            return false;
        }
    }
}
