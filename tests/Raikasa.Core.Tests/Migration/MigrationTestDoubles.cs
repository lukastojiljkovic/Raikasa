using System.Diagnostics;
using System.Security.Cryptography;
using Raikasa.Core.Migration;

namespace Raikasa.Core.Tests.Migration;

/// <summary>Records what the migration asks of Task Scheduler, and answers as told.</summary>
internal sealed class FakeReminderTasks : IReminderTasks
{
    public List<string> Calls { get; } = [];

    public bool DeleteSucceeds { get; set; } = true;

    public bool ScheduleSucceeds { get; set; } = true;

    public Task<bool> DeleteAsync(string name)
    {
        Calls.Add($"delete {name}");
        return Task.FromResult(DeleteSucceeds);
    }

    public Task<bool> ScheduleAsync(int months)
    {
        Calls.Add($"schedule {months}");
        return Task.FromResult(ScheduleSucceeds);
    }
}

/// <summary>The real file operations, with a rename that can fail and copies that can break.</summary>
internal sealed class TestFolderOperations : IFolderOperations
{
    public bool RenameFails { get; init; }

    /// <summary>A copy of the file with this name writes half of it, then fails like a full disk.</summary>
    public string? FailingFile { get; init; }

    /// <summary>A copy of the file with this name ends with one byte changed.</summary>
    public string? CorruptedFile { get; init; }

    public int Renames { get; private set; }

    public int Copies { get; private set; }

    public void MoveDirectory(string source, string destination)
    {
        Renames++;
        if (RenameFails)
            throw new IOException("The folder is in use.");
        FolderOperations.Default.MoveDirectory(source, destination);
    }

    public void CopyFile(string source, string destination)
    {
        Copies++;
        if (Path.GetFileName(source) == FailingFile)
        {
            var bytes = File.ReadAllBytes(source);
            File.WriteAllBytes(destination, bytes[..(bytes.Length / 2)]);
            throw new IOException("There is not enough space on the disk.");
        }

        FolderOperations.Default.CopyFile(source, destination);
        if (Path.GetFileName(source) == CorruptedFile)
        {
            var bytes = File.ReadAllBytes(destination);
            bytes[^1] ^= 0xFF;
            File.WriteAllBytes(destination, bytes);
        }
    }
}

/// <summary>A registry whose write of one value fails, or stores something else.</summary>
internal sealed class FaultyRegistryTree(IRegistryTree inner, string valueName, Func<RegistryValue, RegistryValue> onWrite) : IRegistryTree
{
    public bool KeyExists(string path) => inner.KeyExists(path);

    public IReadOnlyList<string> ValueNames(string path) => inner.ValueNames(path);

    public IReadOnlyList<string> SubKeyNames(string path) => inner.SubKeyNames(path);

    public RegistryValue? GetValue(string path, string name) => inner.GetValue(path, name);

    public void CreateKey(string path) => inner.CreateKey(path);

    public void SetValue(string path, string name, RegistryValue value) =>
        inner.SetValue(path, name, name == valueName ? onWrite(value) : value);

    public void DeleteValue(string path, string name) => inner.DeleteValue(path, name);

    public void DeleteTree(string path) => inner.DeleteTree(path);
}

internal static class TestFiles
{
    /// <summary>Every file below <paramref name="root"/>, by relative path, with its SHA-256.</summary>
    public static SortedDictionary<string, string> Hashes(string root)
    {
        var hashes = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (Directory.Exists(root))
        {
            foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories))
                hashes[Path.GetRelativePath(root, file)] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(file)));
        }
        return hashes;
    }

    public static void Write(string root, string relativePath, byte[] bytes)
    {
        var path = Path.Combine(root, relativePath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, bytes);
    }

    public static void CreateJunction(string path, string target)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using (var mklink = Process.Start(new ProcessStartInfo("cmd.exe", $"/c mklink /J \"{path}\" \"{target}\"") { CreateNoWindow = true, UseShellExecute = false })!)
            mklink.WaitForExit();
        Assert.True(new DirectoryInfo(path).Attributes.HasFlag(FileAttributes.ReparsePoint));
    }

    /// <summary>Removes the junctions first, so that deleting the tree never reaches what they point at.</summary>
    public static void DeleteTree(DirectoryInfo root)
    {
        if (!root.Exists)
            return;
        foreach (var link in root.EnumerateDirectories("*", SearchOption.AllDirectories).Where(d => d.Attributes.HasFlag(FileAttributes.ReparsePoint)).ToList())
            link.Delete();
        root.Delete(recursive: true);
    }
}
