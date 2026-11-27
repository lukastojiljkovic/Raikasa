using Microsoft.Win32;

namespace Raikasa.Core.Migration;

/// <summary>A registry value as it is stored: its kind and its data, with environment names never expanded.</summary>
internal sealed record RegistryValue(RegistryValueKind Kind, object Data)
{
    /// <summary>The same kind and the same data, compared by content.</summary>
    public bool SameAs(RegistryValue? other) => other is not null && Kind == other.Kind && (Data, other.Data) switch
    {
        (string a, string b) => string.Equals(a, b, StringComparison.Ordinal),
        (int a, int b) => a == b,
        (long a, long b) => a == b,
        (string[] a, string[] b) => a.SequenceEqual(b, StringComparer.Ordinal),
        (byte[] a, byte[] b) => a.AsSpan().SequenceEqual(b),
        _ => false,
    };
}

/// <summary>The registry operations the migration needs, on keys below one root, so tests can use a private hive.</summary>
internal interface IRegistryTree
{
    bool KeyExists(string path);

    IReadOnlyList<string> ValueNames(string path);

    IReadOnlyList<string> SubKeyNames(string path);

    /// <summary>The value, or <see langword="null"/> when it is missing or can't be read.</summary>
    RegistryValue? GetValue(string path, string name);

    /// <summary>Creates the key if it is missing.</summary>
    void CreateKey(string path);

    /// <summary>Writes the value, creating its key if it is missing.</summary>
    void SetValue(string path, string name, RegistryValue value);

    /// <summary>Deletes one value; a missing value is not an error.</summary>
    void DeleteValue(string path, string name);

    /// <summary>Deletes the key and everything below it; a missing key is not an error.</summary>
    void DeleteTree(string path);
}

internal sealed class RegistryTree(RegistryKey root) : IRegistryTree
{
    public bool KeyExists(string path)
    {
        using var key = root.OpenSubKey(path);
        return key is not null;
    }

    public IReadOnlyList<string> ValueNames(string path)
    {
        using var key = root.OpenSubKey(path);
        return key?.GetValueNames() ?? [];
    }

    public IReadOnlyList<string> SubKeyNames(string path)
    {
        using var key = root.OpenSubKey(path);
        return key?.GetSubKeyNames() ?? [];
    }

    public RegistryValue? GetValue(string path, string name)
    {
        using var key = root.OpenSubKey(path);
        if (key?.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not { } data)
            return null;
        return new RegistryValue(key.GetValueKind(name), data);
    }

    public void CreateKey(string path) => root.CreateSubKey(path).Dispose();

    public void SetValue(string path, string name, RegistryValue value)
    {
        using var key = root.CreateSubKey(path);
        key.SetValue(name, value.Data, value.Kind);
    }

    public void DeleteValue(string path, string name)
    {
        using var key = root.OpenSubKey(path, writable: true);
        key?.DeleteValue(name, throwOnMissingValue: false);
    }

    public void DeleteTree(string path) => root.DeleteSubKeyTree(path, throwOnMissingSubKey: false);
}

/// <summary>Moves a settings key whole, with its subkeys, under a new name.</summary>
internal static class SettingsKeyMove
{
    /// <summary>
    /// Copies every value and subkey of <paramref name="source"/> that <paramref name="destination"/> lacks, then
    /// reads both back. A value the destination already has wins and is left as it is. Nothing is deleted.
    /// </summary>
    /// <returns>
    /// <see langword="true"/> when every source value is under the destination, each copied one with the same kind
    /// and data, so the source may be deleted.
    /// </returns>
    public static bool CopyAndVerify(IRegistryTree registry, string source, string destination)
    {
        // Value and key names are case-insensitive, and a value name never holds a NUL.
        var copied = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var readable = Copy(string.Empty);
        return Verify(string.Empty) && readable;

        bool Copy(string relative)
        {
            var from = Combine(source, relative);
            var to = Combine(destination, relative);
            registry.CreateKey(to);
            var present = registry.ValueNames(to).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var all = true;
            foreach (var name in registry.ValueNames(from))
            {
                if (present.Contains(name))
                    continue;
                if (registry.GetValue(from, name) is not { Kind: not RegistryValueKind.Unknown } value)
                {
                    all = false;
                    continue;
                }
                registry.SetValue(to, name, value);
                copied.Add(relative + "\0" + name);
            }
            foreach (var subKey in registry.SubKeyNames(from))
                all &= Copy(Combine(relative, subKey));
            return all;
        }

        bool Verify(string relative)
        {
            var from = Combine(source, relative);
            var to = Combine(destination, relative);
            if (!registry.KeyExists(to))
                return false;
            var present = registry.ValueNames(to).ToHashSet(StringComparer.OrdinalIgnoreCase);
            var all = true;
            foreach (var name in registry.ValueNames(from))
            {
                if (!present.Contains(name))
                    all = false;
                else if (copied.Contains(relative + "\0" + name) && registry.GetValue(from, name)?.SameAs(registry.GetValue(to, name)) != true)
                {
                    // A copy that doesn't match isn't kept, so it can't win over the old value at the next start.
                    registry.DeleteValue(to, name);
                    all = false;
                }
            }
            foreach (var subKey in registry.SubKeyNames(from))
                all &= Verify(Combine(relative, subKey));
            return all;
        }
    }

    private static string Combine(string key, string subKey) =>
        key.Length == 0 ? subKey : subKey.Length == 0 ? key : $@"{key}\{subKey}";
}
