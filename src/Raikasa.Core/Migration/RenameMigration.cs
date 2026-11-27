using System.Security;
using System.Security.Principal;
using Microsoft.Win32;

namespace Raikasa.Core.Migration;

/// <summary>The Task Scheduler work the migration asks of the app, which owns the reminder.</summary>
public interface IReminderTasks
{
    /// <summary>Deletes the task of that name.</summary>
    /// <returns><see langword="true"/> when no task of that name is left, also when there was none.</returns>
    Task<bool> DeleteAsync(string name);

    /// <summary>Registers this version's reminder task.</summary>
    /// <returns><see langword="false"/> if Task Scheduler didn't accept it.</returns>
    Task<bool> ScheduleAsync(int months);
}

/// <summary>
/// Moves the per-user state that 2.0.0 kept under the product's previous name to the current one, and removes it for
/// the uninstaller. It runs at every start of the window and does nothing once the old state is gone.
/// </summary>
public sealed class RenameMigration
{
    /// <summary>The settings value that holds the reminder interval in months; zero is off.</summary>
    internal const string ReminderMonthsValue = "ReminderMonths";

    internal const string SettingsKeyPath = @"Software\" + ProductInfo.RegistryKeyName;

    private readonly string _oldDataFolder;
    private readonly string _newDataFolder;
    private readonly IRegistryTree _registry;
    private readonly IReminderTasks _tasks;
    private readonly string _oldTaskName;
    private readonly IFolderOperations _files;

    internal RenameMigration(string localAppData, IRegistryTree registry, IReminderTasks tasks, string userSid, IFolderOperations files)
    {
        _oldDataFolder = Path.Combine(localAppData, LegacyNames.DataFolderName);
        _newDataFolder = Path.Combine(localAppData, ProductInfo.DataFolderName);
        _registry = registry;
        _tasks = tasks;
        _oldTaskName = LegacyNames.TaskNamePrefix + userSid;
        _files = files;
    }

    /// <summary>For the signed-in user: their LocalAppData folder, their HKCU and their scheduled task.</summary>
    public static RenameMigration ForCurrentUser(IReminderTasks tasks)
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            new RegistryTree(Registry.CurrentUser),
            tasks,
            identity.User?.Value ?? throw new InvalidOperationException("The current account has no SID."),
            FolderOperations.Default);
    }

    /// <summary>
    /// Moves what 2.0.0 left: the data folder, the settings key with its subkey, and the reminder task, and removes
    /// the notification sender's key and the URL scheme's key. Nothing old is deleted before its copy is verified, and
    /// a run that stopped part way is continued by the next one.
    /// </summary>
    /// <returns><see langword="true"/> when nothing of the previous name is left to move.</returns>
    public async Task<bool> RunAsync()
    {
        var folder = DataFolderMove.Run(_oldDataFolder, _newDataFolder, _files);
        try
        {
            return await MoveSettingsAsync() && folder;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException)
        {
            // Nothing old is deleted before its copy is verified, so the next start just tries again.
            return false;
        }
    }

    /// <summary>For the uninstaller: removes every per-user item of the previous name.</summary>
    /// <returns><see langword="true"/> when all of them are gone.</returns>
    public async Task<bool> RemoveLegacyAsync()
    {
        var removed = DataFolderMove.RemoveTree(_oldDataFolder);
        foreach (var key in (string[])[LegacyNames.SettingsKeyPath, LegacyNames.AppUserModelIdKeyPath, LegacyNames.SchemeKeyPath])
        {
            try
            {
                _registry.DeleteTree(key);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SecurityException)
            {
                removed = false;
            }
        }
        return await _tasks.DeleteAsync(_oldTaskName) && removed;
    }

    private async Task<bool> MoveSettingsAsync()
    {
        if (_registry.KeyExists(LegacyNames.SettingsKeyPath))
        {
            if (!SettingsKeyMove.CopyAndVerify(_registry, LegacyNames.SettingsKeyPath, SettingsKeyPath))
                return false;

            // Read from the moved settings, where a value the current name already had wins.
            if (_registry.GetValue(SettingsKeyPath, ReminderMonthsValue) is { Kind: RegistryValueKind.DWord, Data: int months and > 0 }
                && !await _tasks.ScheduleAsync(months))
                return false;

            // 2.0.0 created its task only together with its settings, so the task goes while they are still there.
            if (!await _tasks.DeleteAsync(_oldTaskName))
                return false;
        }

        _registry.DeleteTree(LegacyNames.AppUserModelIdKeyPath);
        _registry.DeleteTree(LegacyNames.SchemeKeyPath);
        // Last, so that a start that stopped before this point finds the old settings and does the steps above again.
        _registry.DeleteTree(LegacyNames.SettingsKeyPath);
        return true;
    }
}
