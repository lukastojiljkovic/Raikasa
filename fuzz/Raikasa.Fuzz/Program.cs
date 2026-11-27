using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using Raikasa.Core.Platform;
using Raikasa.Core.Tools;
using Raikasa.Core.Updates;
using SharpFuzz;

namespace Raikasa.Fuzz;

/// <summary>
/// SharpFuzz targets for the parsers of text that another party controls. A target never lets an exception out of a parser
/// that is documented to refuse bad input, and checks what an accepted input must satisfy: a parser that throws, or that
/// accepts what it should refuse, is a crash. <c>FUZZ_TARGET</c> (or the first argument) picks the target.
/// </summary>
internal static class Program
{
    private delegate void Target(ReadOnlySpan<byte> data);

    private static readonly UTF8Encoding Utf8 = new(false);

    private static int Main(string[] args)
    {
        var name = Environment.GetEnvironmentVariable("FUZZ_TARGET") ?? (args.Length > 0 ? args[0] : null);
        Target? target = name switch
        {
            "dism" => RunDism,
            "sfc" => RunSfc,
            "winget" => RunWinget,
            "windows-update" => RunWindowsUpdate,
            "sidecar" => RunSidecar,
            "release" => RunRelease,
            "version" => RunVersion,
            _ => null,
        };
        if (target is null)
        {
            Console.Error.WriteLine("Set FUZZ_TARGET to one of: dism, sfc, winget, windows-update, sidecar, release, version.");
            return 2;
        }

        Fuzzer.LibFuzzer.Run((ReadOnlySpan<byte> data) => target(data));
        return 0;
    }

    private static string[] Lines(ReadOnlySpan<byte> data) => Utf8.GetString(data).Split('\n');

    private static void Require([DoesNotReturnIf(false)] bool condition, string what)
    {
        if (!condition)
            throw new InvalidOperationException(what);
    }

    private static void RunDism(ReadOnlySpan<byte> data)
    {
        foreach (var line in Lines(data))
        {
            if (Dism.ParseProgress(line) is { } percent)
                Require(percent is >= 0 and <= 999.9, "DISM progress outside 0 to 999.9");
        }
    }

    private static void RunSfc(ReadOnlySpan<byte> data)
    {
        var lines = Lines(data);
        foreach (var line in lines)
        {
            if (SfcAnalyzer.ParseProgress(line) is { } percent)
                Require(percent is >= 0 and <= 999, "SFC progress outside 0 to 999");
        }

        // The first half of the lines stands for the console, the second half for the [SR] lines of CBS.log.
        var half = lines.Length / 2;
        var verdict = SfcAnalyzer.Analyze(lines[..half], lines[half..]);
        Require(Enum.IsDefined(verdict), "SFC verdict is not a defined value");
    }

    private static void RunWinget(ReadOnlySpan<byte> data)
    {
        var lines = Lines(data);
        foreach (var line in lines)
        {
            if (Winget.ParseCounter(line) is { } counter)
                Require(counter.Index >= 0 && counter.Count >= 0, "winget counter is negative");
        }

        var exitCode = data.Length >= 4 ? BitConverter.ToInt32(data[..4]) : 0;
        Winget.Classify(exitCode, lines);
    }

    private static void RunWindowsUpdate(ReadOnlySpan<byte> data)
    {
        var lines = Lines(data);

        // The script's output goes through the "@@" JSON-line reader of the app. Text that is not JSON is its documented refusal.
        try
        {
            PowerShell.Messages(lines.Select(line => PowerShell.IsMessage(line) ? line : "@@" + line).ToArray());
        }
        catch (JsonException)
        {
        }

        // The script's own messages have a fixed shape; what varies is their content. Build them from the input and read them.
        var hresult = data.Length >= 4 ? BitConverter.ToInt32(data[..4]) : 0;
        var messages = new List<string>();
        foreach (var line in lines)
        {
            var kind = line.Length == 0 ? 0 : line[0] % 4;
            messages.Add(kind switch
            {
                0 => "@@" + JsonSerializer.Serialize(new { installed = line }),
                1 => "@@" + JsonSerializer.Serialize(new { failed = line, hresult }),
                2 => "@@" + JsonSerializer.Serialize(new { found = line.Length }),
                _ => "@@" + JsonSerializer.Serialize(new { done = true, restart = line.Length % 2 == 0 }),
            });
        }

        var result = WindowsUpdateTool.Interpret(PowerShell.Messages(messages));
        Require(!string.IsNullOrEmpty(result.Summary), "an update result has no summary");
    }

    private static bool IsHttps(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps;

    private static void RunSidecar(ReadOnlySpan<byte> data)
    {
        // The first byte sets how many bytes after it are the expected file name; the rest is the sidecar body.
        if (data.IsEmpty)
            return;
        var nameLength = Math.Min(data[0], data.Length - 1);
        var fileName = Utf8.GetString(data.Slice(1, nameLength));
        var body = Utf8.GetString(data[(1 + nameLength)..]);

        var accepted = SidecarParser.TryParse(body, fileName, out var hash);
        if (accepted)
        {
            Require(hash.Length == 64 && hash.All(c => c is (>= '0' and <= '9') or (>= 'a' and <= 'f')), "accepted a hash that is not 64 lowercase hex digits");
            Require(body.Contains(hash, StringComparison.OrdinalIgnoreCase), "accepted a hash that is not in the body");
            Require(body.Contains(fileName, StringComparison.Ordinal), "accepted a body that does not name the file");
        }
        else
        {
            Require(hash.Length == 0, "a refused sidecar left a hash");
        }
    }

    private static void RunRelease(ReadOnlySpan<byte> data)
    {
        var accepted = ReleaseReader.TryParse(Utf8.GetString(data), out var release, out var failure);
        if (accepted)
        {
            Require(release is not null, "accepted a release without one");
            Require(release.Version.Major >= 0 && release.Version.Minor >= 0 && release.Version.Build >= 0, "negative version");
            Require(release.InstallerUrl is null || IsHttps(release.InstallerUrl), "accepted a download that is not https");
            Require(release.SidecarUrl is null || IsHttps(release.SidecarUrl), "accepted a checksum link that is not https");
        }
        else
        {
            Require(release is null && !string.IsNullOrEmpty(failure), "a refused release gave no reason or kept a release");
        }
    }

    private static void RunVersion(ReadOnlySpan<byte> data)
    {
        var tag = Utf8.GetString(data);
        var accepted = UpdateVersion.TryParseTag(tag, out var version);
        if (accepted)
        {
            Require(tag.StartsWith('v') && tag.Count(c => c == '.') == 2, "accepted a tag that is not vMAJOR.MINOR.PATCH");
            Require(version.Major >= 0 && version.Minor >= 0 && version.Build >= 0 && version.Revision == -1, "version has a negative or a fourth part");
        }
    }
}
