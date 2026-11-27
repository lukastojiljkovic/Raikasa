using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;
using Raikasa.Core.Migration;

namespace Raikasa.Core.Tests.Migration;

/// <summary>
/// A private registry hive in a temporary file, which stands in for HKCU. Only this process sees it, and Windows
/// unloads it when the last handle closes, so the tests never change the real registry.
/// </summary>
internal sealed partial class AppHive : IDisposable
{
    private const int KeyAllAccess = 0xF003F;

    private readonly DirectoryInfo _directory = Directory.CreateTempSubdirectory($"{ProductInfo.Id}-tests-");

    public AppHive()
    {
        var error = RegLoadAppKey(Path.Combine(_directory.FullName, "hive.dat"), out var handle, KeyAllAccess, 0, 0);
        if (error != 0)
            throw new Win32Exception(error);
        Root = RegistryKey.FromHandle(handle);
        Tree = new RegistryTree(Root);
    }

    public RegistryKey Root { get; }

    internal RegistryTree Tree { get; }

    public void Set(string path, string name, object data, RegistryValueKind kind)
    {
        using var key = Root.CreateSubKey(path);
        key.SetValue(name, data, kind);
    }

    public bool Exists(string path)
    {
        using var key = Root.OpenSubKey(path);
        return key is not null;
    }

    /// <summary>
    /// Every value below <paramref name="path"/> (the whole hive when it is empty), keyed by its subkey path and name,
    /// with its kind and its data; arrays are spelled out so that two snapshots compare by content.
    /// </summary>
    public SortedDictionary<string, (RegistryValueKind Kind, object Data)> Snapshot(string path)
    {
        var values = new SortedDictionary<string, (RegistryValueKind, object)>(StringComparer.Ordinal);
        Collect(path, string.Empty);
        return values;

        void Collect(string keyPath, string relative)
        {
            using var key = keyPath.Length == 0 ? null : Root.OpenSubKey(keyPath);
            var current = keyPath.Length == 0 ? Root : key;
            if (current is null)
                return;
            foreach (var name in current.GetValueNames())
            {
                var data = current.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames)!;
                values[$@"{relative}\{name}"] = (current.GetValueKind(name), data switch
                {
                    string[] lines => string.Join('|', lines),
                    byte[] bytes => Convert.ToHexString(bytes),
                    _ => data,
                });
            }
            foreach (var subKey in current.GetSubKeyNames())
                Collect(keyPath.Length == 0 ? subKey : $@"{keyPath}\{subKey}", $@"{relative}\{subKey}");
        }
    }

    public void DeleteValue(string path, string name)
    {
        using var key = Root.OpenSubKey(path, writable: true);
        key?.DeleteValue(name);
    }

    public void Dispose()
    {
        Root.Dispose();
        try
        {
            _directory.Delete(recursive: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The hive file is released when Windows finishes unloading it; a leftover temporary file is harmless.
        }
    }

    [LibraryImport("advapi32.dll", EntryPoint = "RegLoadAppKeyW", StringMarshalling = StringMarshalling.Utf16)]
    private static partial int RegLoadAppKey(string file, out SafeRegistryHandle key, int samDesired, int options, int reserved);
}
