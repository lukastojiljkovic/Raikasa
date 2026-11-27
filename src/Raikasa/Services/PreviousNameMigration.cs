using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Raikasa.Core.Migration;

namespace Raikasa.Services;

/// <summary>
/// Moves the settings, history, logs and reminder that 2.0.0 kept under the product's previous name, and removes them
/// for the uninstaller. The work itself is <see cref="RenameMigration"/>; this class connects it to the reminder.
/// </summary>
internal static partial class PreviousNameMigration
{
    private const int TokenElevationTypeClass = 18;
    private const int TokenElevationTypeFull = 2;

    /// <summary>
    /// Runs at every start of the window, before anything reads a setting, and does nothing once the old state is gone.
    /// It never keeps the window from opening: whatever it can't finish now, a later start finishes.
    /// </summary>
    public static void RunAtStart()
    {
        // A copy started with "Run as administrator" may run as another account, whose profile is not the one to move,
        // so it leaves the move to the next normal start. Without UAC's split token (UAC off, or the built-in
        // Administrator) every start runs elevated as the account itself, so the move runs there.
        if (IsElevatedWithSplitToken())
            return;

        try
        {
            RenameMigration.ForCurrentUser(new ReminderTasks()).RunAsync().GetAwaiter().GetResult();
        }
        catch (Exception)
        {
            // Nothing old is deleted before its copy is verified, so a failure leaves both and the next start retries.
        }
    }

    /// <summary>For the uninstaller.</summary>
    /// <returns><see langword="true"/> when every per-user item of the previous name is gone.</returns>
    public static Task<bool> RemoveAsync() => RenameMigration.ForCurrentUser(new ReminderTasks()).RemoveLegacyAsync();

    /// <summary>An elevated token that has a limited twin, the one the session's other processes run with; fails closed.</summary>
    private static bool IsElevatedWithSplitToken()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return !GetTokenInformation(identity.Token, TokenElevationTypeClass, out var type, sizeof(int), out _) || type == TokenElevationTypeFull;
    }

    [LibraryImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetTokenInformation(nint token, int informationClass, out int information, int length, out int returnLength);

    private sealed class ReminderTasks : IReminderTasks
    {
        public async Task<bool> DeleteAsync(string name)
        {
            try
            {
                return await Reminder.DeleteTaskAsync(name);
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
            {
                return false;
            }
        }

        public async Task<bool> ScheduleAsync(int months)
        {
            try
            {
                return await Reminder.ScheduleAsync(months);
            }
            catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
            {
                return false;
            }
        }
    }
}
