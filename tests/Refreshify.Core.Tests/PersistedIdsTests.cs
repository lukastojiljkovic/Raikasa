using System.Text;
using Refreshify.Core.Catalog;
using Refreshify.Core.Engine;
using Refreshify.Core.Platform;
using Refreshify.Core.Tools;
using Refreshify.Core.Updates;

namespace Refreshify.Core.Tests;

/// <summary>
/// What 2.0.0 writes to the user's PC or sends to GitHub and expects to find again. Every value is pinned to the one
/// 2.0.0 used, so that nothing moves them by accident.
/// </summary>
public class PersistedIdsTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class CapturingRunner : IProcessRunner
    {
        public List<ProcessSpec> Specs { get; } = [];

        public Task<ProcessResult> RunAsync(ProcessSpec spec, Action<string>? onLine, CancellationToken cancellationToken)
        {
            Specs.Add(spec);
            return Task.FromResult(new ProcessResult(0, []));
        }
    }

    [Fact]
    public void The_ids_are_the_ones_2_0_0_wrote()
    {
        Assert.Equal("Refreshify", ProductInfo.Name);
        Assert.Equal("refreshify", ProductInfo.Id);
        Assert.Equal("REFRESHIFY_", ProductInfo.EnvironmentPrefix);
        Assert.Equal("Refreshify", ProductInfo.DataFolderName);
        Assert.Equal("Refreshify", ProductInfo.RegistryKeyName);
        Assert.Equal("LukaStojiljkovic.Refreshify", ProductInfo.AppUserModelId);
        Assert.Equal("refreshify", ProductInfo.Scheme);
        Assert.Equal("Refreshify reminder-", ProductInfo.TaskNamePrefix);
    }

    [Fact]
    public void The_folders_under_local_app_data_are_the_ones_2_0_0_used()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        Assert.Equal(Path.Combine(root, "Refreshify", "History"), HistoryStore.DefaultDirectory);
        Assert.Equal(Path.Combine(root, "Refreshify", "Updates"), UpdateDownloader.DefaultUpdatesDirectory);
    }

    [Fact]
    public void The_updater_talks_to_the_repository_and_asset_2_0_0_used()
    {
        Assert.Equal("lukastojiljkovic", ReleaseReader.Owner);
        Assert.Equal("Refreshify", ReleaseReader.Repository);
        Assert.Equal("Refreshify", ReleaseReader.AssetPrefix);
        Assert.Equal("https://github.com/lukastojiljkovic/Refreshify", ReleaseReader.RepositoryUrl);
        Assert.Equal("https://github.com/lukastojiljkovic/Refreshify/releases/latest", ReleaseReader.ReleasePageUrl);
        Assert.Equal("https://api.github.com/repos/lukastojiljkovic/Refreshify/releases/latest", ReleaseReader.ApiLatestUrl);
        Assert.Equal("Refreshify", ProductInfo.UserAgentProduct);
    }

    [Theory]
    [InlineData("windows-update", "ClientId")]
    [InlineData("restore-point", "Description")]
    public async Task The_scripts_that_name_the_product_still_say_Refreshify(string toolId, string parameter)
    {
        var runner = new CapturingRunner();
        var context = new ToolContext(new ToolOptions(), new SynchronousProgress<ToolEvent>(_ => { }), runner);

        await ToolRunner.RunAsync(ToolCatalog.Find(toolId)!, context, Ct);

        const string marker = "-EncodedCommand ";
        var arguments = Assert.Single(runner.Specs).Arguments;
        var script = Encoding.Unicode.GetString(Convert.FromBase64String(arguments[(arguments.IndexOf(marker, StringComparison.Ordinal) + marker.Length)..]));
        Assert.Contains($"${parameter} = 'Refreshify'", script, StringComparison.Ordinal);
    }
}
