using Raikasa.Core.Migration;

namespace Raikasa.Core.Tests.Migration;

public class LegacyNamesTests
{
    // The names 2.0.0 used (AppSettings.cs, Reminder.cs and RunCoordinator.cs at v2.0.0), spelled out once here.
    [Fact]
    public void Are_the_names_that_2_0_0_wrote()
    {
        Assert.Equal("Refreshify", LegacyNames.DataFolderName);
        Assert.Equal(@"Software\Refreshify", LegacyNames.SettingsKeyPath);
        Assert.Equal(@"Software\Classes\AppUserModelId\LukaStojiljkovic.Refreshify", LegacyNames.AppUserModelIdKeyPath);
        Assert.Equal(@"Software\Classes\refreshify", LegacyNames.SchemeKeyPath);
        Assert.Equal("Refreshify reminder-", LegacyNames.TaskNamePrefix);
    }
}
