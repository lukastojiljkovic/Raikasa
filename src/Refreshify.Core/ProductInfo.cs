namespace Refreshify;

/// <summary>
/// The product's name and every id the code derives from it at run time. This is the one place in C# that spells
/// the name; the build files take it from <c>ProductName</c> in <c>Directory.Build.props</c>, and a test keeps the two
/// equal. Prose in XAML and the documents keeps the literal name.
/// </summary>
public static class ProductInfo
{
    /// <summary>The display name, and the stem of the exe, the assemblies and the installer.</summary>
    public const string Name = "Refreshify";

    /// <summary>The lowercase id: the URL scheme, and the prefix of temporary file names.</summary>
    public const string Id = "refreshify";

    /// <summary>The prefix of environment variables that switch on debug behavior, with the trailing underscore.</summary>
    public const string EnvironmentPrefix = "REFRESHIFY_";

    /// <summary>The GitHub account that owns the repository.</summary>
    public const string RepositoryOwner = "lukastojiljkovic";

    /// <summary>The GitHub repository name.</summary>
    public const string RepositoryName = Name;

    /// <summary>The repository's web address, without a trailing slash.</summary>
    public const string RepositoryUrl = "https://github.com/" + RepositoryOwner + "/" + RepositoryName;

    /// <summary>The installer asset is <c>{AssetPrefix}-{version}-Setup.exe</c>.</summary>
    public const string AssetPrefix = Name;

    /// <summary>The product token of the <c>User-Agent</c> header sent to GitHub.</summary>
    public const string UserAgentProduct = Name;

    /// <summary>The folder under <c>%LOCALAPPDATA%</c> that holds history, logs and downloaded installers.</summary>
    public const string DataFolderName = Name;

    /// <summary>The key under <c>HKCU\Software</c> that holds the settings.</summary>
    public const string RegistryKeyName = Name;

    /// <summary>The notification sender's AppUserModelId.</summary>
    public const string AppUserModelId = "LukaStojiljkovic." + Name;

    /// <summary>The URL scheme that a reminder notification opens, without the colon.</summary>
    public const string Scheme = Id;

    /// <summary>The reminder task's name is this prefix followed by the user's SID.</summary>
    public const string TaskNamePrefix = Name + " reminder-";
}
