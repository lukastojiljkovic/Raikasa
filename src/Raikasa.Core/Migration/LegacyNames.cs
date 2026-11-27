namespace Raikasa.Core.Migration;

/// <summary>
/// The per-user names that 2.0.0 used before the product was renamed. Only the first start's migration and the
/// uninstaller use them, to move or remove what 2.0.0 left behind.
/// </summary>
internal static class LegacyNames
{
    private const string Name = "Refreshify";

    /// <summary>The data folder under <c>%LOCALAPPDATA%</c>, with History, Logs and Updates.</summary>
    public const string DataFolderName = Name;

    /// <summary>The settings key under <c>HKCU</c>: 13 values and the <c>Tools</c> subkey.</summary>
    public const string SettingsKeyPath = @"Software\" + Name;

    /// <summary>The notification sender's key under <c>HKCU</c>, written once a reminder was due.</summary>
    public const string AppUserModelIdKeyPath = @"Software\Classes\AppUserModelId\LukaStojiljkovic." + Name;

    /// <summary>The URL scheme's key under <c>HKCU</c>, written once a reminder was due.</summary>
    public const string SchemeKeyPath = @"Software\Classes\refreshify";

    /// <summary>The reminder task's name is this prefix followed by the user's SID.</summary>
    public const string TaskNamePrefix = Name + " reminder-";
}
