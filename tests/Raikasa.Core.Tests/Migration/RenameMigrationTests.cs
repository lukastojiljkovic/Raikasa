using System.Security.Cryptography;
using Microsoft.Win32;
using Raikasa.Core.Migration;

namespace Raikasa.Core.Tests.Migration;

public sealed class RenameMigrationTests : IDisposable
{
    private const string Sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
    private const string NewKey = RenameMigration.SettingsKeyPath;
    private const string OldKey = LegacyNames.SettingsKeyPath;
    private const string OldTask = "delete " + LegacyNames.TaskNamePrefix + Sid;
    private const string UninstallEntry = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{C702E743-6E7D-4276-9FDB-DB7B6FFC181A}_is1";

    private readonly AppHive _hive = new();
    private readonly DirectoryInfo _localAppData = Directory.CreateTempSubdirectory($"{ProductInfo.Id}-tests-");
    private readonly FakeReminderTasks _tasks = new();

    public void Dispose()
    {
        _hive.Dispose();
        TestFiles.DeleteTree(_localAppData);
    }

    private string OldFolder => Path.Combine(_localAppData.FullName, LegacyNames.DataFolderName);

    private string NewFolder => Path.Combine(_localAppData.FullName, ProductInfo.DataFolderName);

    private RenameMigration Migration(IRegistryTree? registry = null) =>
        new(_localAppData.FullName, registry ?? _hive.Tree, _tasks, Sid, FolderOperations.Default);

    /// <summary>What 2.0.0 writes: 13 values, one DWORD per tool id under <c>Tools</c>, and History, Logs and Updates.</summary>
    private void Create200State(int reminderMonths = 3)
    {
        _hive.Set(OldKey, "Theme", 2, RegistryValueKind.DWord);
        _hive.Set(OldKey, "CreateRestorePoint", 0, RegistryValueKind.DWord);
        _hive.Set(OldKey, "FixAutomatically", 1, RegistryValueKind.DWord);
        _hive.Set(OldKey, "TempFileAgeHours", 48, RegistryValueKind.DWord);
        _hive.Set(OldKey, "ShowTechnicalDetails", 1, RegistryValueKind.DWord);
        _hive.Set(OldKey, "HidePersonalDetails", 0, RegistryValueKind.DWord);
        _hive.Set(OldKey, RenameMigration.ReminderMonthsValue, reminderMonths, RegistryValueKind.DWord);
        _hive.Set(OldKey, "ShowWelcome", 0, RegistryValueKind.DWord);
        _hive.Set(OldKey, "CheckForUpdatesAutomatically", 0, RegistryValueKind.DWord);
        _hive.Set(OldKey, "LastFullRefresh", 1_759_910_400L, RegistryValueKind.QWord);
        _hive.Set(OldKey, "LastReminder", 1_760_515_200L, RegistryValueKind.QWord);
        _hive.Set(OldKey, "LastUpdateCheckUtc", 1_761_000_000L, RegistryValueKind.QWord);
        _hive.Set(OldKey, "LastRunVersion", "2.0.0", RegistryValueKind.String);
        _hive.Set($@"{OldKey}\Tools", "clean-temp-files", 0, RegistryValueKind.DWord);
        _hive.Set($@"{OldKey}\Tools", "dism-restore-health", 1, RegistryValueKind.DWord);
        _hive.Set($@"{OldKey}\Tools", "sfc-scan", 1, RegistryValueKind.DWord);

        _hive.Set(LegacyNames.AppUserModelIdKeyPath, "DisplayName", "2.0.0", RegistryValueKind.String);
        _hive.Set(LegacyNames.SchemeKeyPath, "URL Protocol", string.Empty, RegistryValueKind.String);
        _hive.Set($@"{LegacyNames.SchemeKeyPath}\shell\open\command", string.Empty, @"""C:\Program Files\app.exe""", RegistryValueKind.String);

        TestFiles.Write(OldFolder, @"History\20261001-120000.json", RandomNumberGenerator.GetBytes(800));
        TestFiles.Write(OldFolder, @"Logs\20261001-120000.log", RandomNumberGenerator.GetBytes(4000));
        TestFiles.Write(OldFolder, @"Updates\Setup-2.0.0.exe", RandomNumberGenerator.GetBytes(20_000));
    }

    /// <summary>Keys that are not the previous name's, which the migration must leave as they are.</summary>
    private void CreateUnrelatedKeys()
    {
        _hive.Set(UninstallEntry, "DisplayName", "2.0.0", RegistryValueKind.String);
        _hive.Set(@"Software\Classes\AppUserModelId\Contoso.Other", "DisplayName", "Other", RegistryValueKind.String);
        _hive.Set(@"Software\Classes\" + ProductInfo.Scheme, "URL Protocol", string.Empty, RegistryValueKind.String);
    }

    [Fact]
    public async Task Moves_the_settings_key_with_all_13_values_and_the_Tools_subkey()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        Assert.Equal(16, expected.Count);

        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(NewKey));
        Assert.False(_hive.Exists(OldKey));
    }

    [Fact]
    public async Task Moves_the_data_folder()
    {
        Create200State();
        var expected = TestFiles.Hashes(OldFolder);

        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, TestFiles.Hashes(NewFolder));
        Assert.False(Directory.Exists(OldFolder));
    }

    [Fact]
    public async Task A_value_the_new_key_already_has_wins()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        _hive.Set(NewKey, "Theme", 1, RegistryValueKind.DWord);
        _hive.Set(NewKey, "LastRunVersion", "2.0.1", RegistryValueKind.String);
        expected[@"\Theme"] = (RegistryValueKind.DWord, 1);
        expected[@"\LastRunVersion"] = (RegistryValueKind.String, "2.0.1");

        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(NewKey));
        Assert.False(_hive.Exists(OldKey));
    }

    [Fact]
    public async Task A_settings_copy_that_fails_part_way_keeps_the_old_key_whole_and_the_next_start_finishes_it()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        var failing = new FaultyRegistryTree(_hive.Tree, "LastReminder", _ => throw new UnauthorizedAccessException());

        Assert.False(await Migration(failing).RunAsync());

        Assert.Equal(expected, _hive.Snapshot(OldKey));
        Assert.True(_hive.Exists(LegacyNames.AppUserModelIdKeyPath));
        Assert.Empty(_tasks.Calls);

        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(NewKey));
        Assert.False(_hive.Exists(OldKey));
    }

    [Fact]
    public async Task A_value_that_reads_back_differently_keeps_the_old_key()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        var corrupting = new FaultyRegistryTree(_hive.Tree, "LastFullRefresh", value => value with { Kind = RegistryValueKind.String, Data = "0" });

        Assert.False(await Migration(corrupting).RunAsync());

        Assert.Equal(expected, _hive.Snapshot(OldKey));
        Assert.Empty(_tasks.Calls);

        // The copy that didn't match was not kept, so it can't win over the old value at the next start.
        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(NewKey));
        Assert.False(_hive.Exists(OldKey));
    }

    [Fact]
    public async Task Copies_every_kind_of_value_as_stored()
    {
        _hive.Set(OldKey, string.Empty, "default", RegistryValueKind.String);
        _hive.Set(OldKey, "Expand", @"%LOCALAPPDATA%\x", RegistryValueKind.ExpandString);
        _hive.Set(OldKey, "Multi", new[] { "a", "b" }, RegistryValueKind.MultiString);
        _hive.Set(OldKey, "Binary", new byte[] { 1, 2, 3 }, RegistryValueKind.Binary);
        _hive.Set(OldKey, "Negative", -1, RegistryValueKind.DWord);
        _hive.Root.CreateSubKey($@"{OldKey}\Empty").Dispose();
        var expected = _hive.Snapshot(OldKey);

        Assert.True(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(NewKey));
        Assert.True(_hive.Exists($@"{NewKey}\Empty"));
        Assert.False(_hive.Exists(OldKey));
    }

    [Fact]
    public async Task Registers_the_new_reminder_before_it_deletes_the_old_task_when_the_reminder_is_on()
    {
        Create200State(reminderMonths: 3);

        Assert.True(await Migration().RunAsync());

        Assert.Equal(["schedule 3", OldTask], _tasks.Calls);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(null)]
    public async Task Deletes_the_old_task_and_registers_none_when_the_reminder_is_off(int? reminderMonths)
    {
        Create200State();
        if (reminderMonths is { } months)
            _hive.Set(OldKey, RenameMigration.ReminderMonthsValue, months, RegistryValueKind.DWord);
        else
            _hive.DeleteValue(OldKey, RenameMigration.ReminderMonthsValue);

        Assert.True(await Migration().RunAsync());

        Assert.Equal([OldTask], _tasks.Calls);
    }

    [Fact]
    public async Task Reads_the_reminder_from_the_moved_settings_where_the_new_value_wins()
    {
        Create200State(reminderMonths: 3);
        _hive.Set(NewKey, RenameMigration.ReminderMonthsValue, 0, RegistryValueKind.DWord);

        Assert.True(await Migration().RunAsync());

        Assert.Equal([OldTask], _tasks.Calls);
    }

    [Fact]
    public async Task Keeps_the_old_settings_until_the_old_task_is_gone()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        _tasks.DeleteSucceeds = false;

        Assert.False(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(OldKey));
        Assert.Equal(expected, _hive.Snapshot(NewKey));

        _tasks.DeleteSucceeds = true;
        Assert.True(await Migration().RunAsync());

        Assert.False(_hive.Exists(OldKey));
        Assert.Equal(["schedule 3", OldTask, "schedule 3", OldTask], _tasks.Calls);
    }

    [Fact]
    public async Task Keeps_the_old_task_and_settings_when_Task_Scheduler_refuses_the_new_reminder()
    {
        Create200State();
        var expected = _hive.Snapshot(OldKey);
        _tasks.ScheduleSucceeds = false;

        Assert.False(await Migration().RunAsync());

        Assert.Equal(expected, _hive.Snapshot(OldKey));
        Assert.Equal(["schedule 3"], _tasks.Calls);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Removes_the_notification_and_scheme_keys_and_touches_no_other_key(bool withSettings)
    {
        Create200State();
        if (!withSettings)
            _hive.Root.DeleteSubKeyTree(OldKey);
        CreateUnrelatedKeys();
        var unrelated = UnrelatedKeys();

        Assert.True(await Migration().RunAsync());

        Assert.False(_hive.Exists(LegacyNames.AppUserModelIdKeyPath));
        Assert.False(_hive.Exists(LegacyNames.SchemeKeyPath));
        Assert.Equal(unrelated, UnrelatedKeys());
    }

    /// <summary>Every value in the hive except the settings, which move, and the previous name's two keys.</summary>
    private SortedDictionary<string, (RegistryValueKind Kind, object Data)> UnrelatedKeys()
    {
        string[] ours = [OldKey, NewKey, LegacyNames.AppUserModelIdKeyPath, LegacyNames.SchemeKeyPath];
        var all = _hive.Snapshot(string.Empty);
        foreach (var name in all.Keys.Where(name => ours.Any(key => name.StartsWith($@"\{key}\", StringComparison.Ordinal))).ToList())
            all.Remove(name);
        Assert.Equal(3, all.Count);
        return all;
    }

    [Fact]
    public async Task Does_nothing_when_nothing_of_the_previous_name_is_there()
    {
        Assert.True(await Migration().RunAsync());

        Assert.Empty(_tasks.Calls);
        Assert.False(_hive.Exists(NewKey));
        Assert.False(Directory.Exists(NewFolder));
    }

    [Fact]
    public async Task Running_again_changes_nothing()
    {
        Create200State();
        CreateUnrelatedKeys();
        Assert.True(await Migration().RunAsync());
        var registry = _hive.Snapshot(string.Empty);
        var files = TestFiles.Hashes(_localAppData.FullName);
        var calls = _tasks.Calls.Count;

        Assert.True(await Migration().RunAsync());

        Assert.Equal(registry, _hive.Snapshot(string.Empty));
        Assert.Equal(files, TestFiles.Hashes(_localAppData.FullName));
        Assert.Equal(calls, _tasks.Calls.Count);
    }

    [Fact]
    public async Task RemoveLegacyAsync_removes_every_per_user_item_of_the_previous_name_and_nothing_else()
    {
        Create200State();
        CreateUnrelatedKeys();
        _hive.Set(NewKey, "Theme", 1, RegistryValueKind.DWord);
        TestFiles.Write(NewFolder, @"History\20261101-100000.json", RandomNumberGenerator.GetBytes(100));
        var settings = _hive.Snapshot(NewKey);
        var unrelated = UnrelatedKeys();
        var files = TestFiles.Hashes(NewFolder);

        Assert.True(await Migration().RemoveLegacyAsync());

        Assert.False(_hive.Exists(OldKey));
        Assert.False(_hive.Exists(LegacyNames.AppUserModelIdKeyPath));
        Assert.False(_hive.Exists(LegacyNames.SchemeKeyPath));
        Assert.False(Directory.Exists(OldFolder));
        Assert.Equal([OldTask], _tasks.Calls);

        // The current name's items are the uninstaller's own job, and the rest is not ours.
        Assert.Equal(settings, _hive.Snapshot(NewKey));
        Assert.Equal(unrelated, UnrelatedKeys());
        Assert.Equal(files, TestFiles.Hashes(NewFolder));
    }

    [Fact]
    public async Task RemoveLegacyAsync_reports_an_old_task_that_stays_and_still_removes_the_rest()
    {
        Create200State();
        _tasks.DeleteSucceeds = false;

        Assert.False(await Migration().RemoveLegacyAsync());

        Assert.False(_hive.Exists(OldKey));
        Assert.False(_hive.Exists(LegacyNames.SchemeKeyPath));
        Assert.False(Directory.Exists(OldFolder));
    }
}
