using System.Text;
using Raikasa.Core.Catalog;
using Raikasa.Core.Engine;
using Raikasa.Core.Platform;
using Raikasa.Core.Tools;
using Raikasa.Core.Updates;

namespace Raikasa.Core.Tests;

/// <summary>
/// What 2.0.1 writes to the user's PC or sends to GitHub and expects to find again. Every value is pinned, so that
/// nothing moves them by accident.
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
    public void The_ids_are_the_ones_2_0_1_writes()
    {
        Assert.Equal("Raikasa", ProductInfo.Name);
        Assert.Equal("raikasa", ProductInfo.Id);
        Assert.Equal("RAIKASA_", ProductInfo.EnvironmentPrefix);
        Assert.Equal("Raikasa", ProductInfo.DataFolderName);
        Assert.Equal("Raikasa", ProductInfo.RegistryKeyName);
        Assert.Equal("LukaStojiljkovic.Raikasa", ProductInfo.AppUserModelId);
        Assert.Equal("raikasa", ProductInfo.Scheme);
        Assert.Equal("Raikasa reminder-", ProductInfo.TaskNamePrefix);
    }

    [Fact]
    public void The_folders_under_local_app_data_are_the_ones_2_0_1_uses()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        Assert.Equal(Path.Combine(root, "Raikasa", "History"), HistoryStore.DefaultDirectory);
        Assert.Equal(Path.Combine(root, "Raikasa", "Updates"), UpdateDownloader.DefaultUpdatesDirectory);
    }

    [Fact]
    public void The_updater_talks_to_the_repository_and_asset_2_0_1_uses()
    {
        Assert.Equal("lukastojiljkovic", ReleaseReader.Owner);
        Assert.Equal("Raikasa", ReleaseReader.Repository);
        Assert.Equal("Raikasa", ReleaseReader.AssetPrefix);
        Assert.Equal("https://github.com/lukastojiljkovic/Raikasa", ReleaseReader.RepositoryUrl);
        Assert.Equal("https://github.com/lukastojiljkovic/Raikasa/releases/latest", ReleaseReader.ReleasePageUrl);
        Assert.Equal("https://api.github.com/repos/lukastojiljkovic/Raikasa/releases/latest", ReleaseReader.ApiLatestUrl);
        Assert.Equal("Raikasa", ProductInfo.UserAgentProduct);
    }

    [Theory]
    [InlineData("windows-update", "ClientId")]
    [InlineData("restore-point", "Description")]
    public async Task The_scripts_that_name_the_product_say_Raikasa(string toolId, string parameter)
    {
        var runner = new CapturingRunner();
        var context = new ToolContext(new ToolOptions(), new SynchronousProgress<ToolEvent>(_ => { }), runner);

        await ToolRunner.RunAsync(ToolCatalog.Find(toolId)!, context, Ct);

        const string marker = "-EncodedCommand ";
        var arguments = Assert.Single(runner.Specs).Arguments;
        var script = Encoding.Unicode.GetString(Convert.FromBase64String(arguments[(arguments.IndexOf(marker, StringComparison.Ordinal) + marker.Length)..]));
        Assert.Contains($"${parameter} = 'Raikasa'", script, StringComparison.Ordinal);
    }
}
