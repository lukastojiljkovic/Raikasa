using System.Security.Cryptography;
using Raikasa.Core.Migration;

namespace Raikasa.Core.Tests.Migration;

public sealed class DataFolderMoveTests : IDisposable
{
    // The layout 2.0.0 leaves: run history, raw logs and the last downloaded installer.
    private static readonly (string Path, int Size)[] Layout =
    [
        (@"History\20261001-120000.json", 700),
        (@"History\20261002-090000.json", 900),
        (@"Logs\20261001-120000.log", 5000),
        (@"Updates\Setup-2.0.0.exe", 300_000),
    ];

    private readonly DirectoryInfo _root = Directory.CreateTempSubdirectory($"{ProductInfo.Id}-tests-");

    private string Old => Path.Combine(_root.FullName, "Old");

    private string New => Path.Combine(_root.FullName, "New");

    private string Outside => Path.Combine(_root.FullName, "Outside");

    public void Dispose() => TestFiles.DeleteTree(_root);

    private SortedDictionary<string, string> CreateOld()
    {
        foreach (var (path, size) in Layout)
            TestFiles.Write(Old, path, RandomNumberGenerator.GetBytes(size));
        return TestFiles.Hashes(Old);
    }

    private bool Move(IFolderOperations? files = null) => DataFolderMove.Run(Old, New, files ?? FolderOperations.Default);

    [Fact]
    public void Renames_the_folder_when_the_new_one_does_not_exist()
    {
        var expected = CreateOld();
        var files = new TestFolderOperations();

        Assert.True(Move(files));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
        Assert.Equal((1, 0), (files.Renames, files.Copies));
    }

    [Fact]
    public void Copies_verifies_and_then_removes_the_old_folder_when_the_rename_fails()
    {
        var expected = CreateOld();
        var files = new TestFolderOperations { RenameFails = true };

        Assert.True(Move(files));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
        Assert.Equal(Layout.Length, files.Copies);
    }

    [Fact]
    public void Copies_into_a_new_folder_that_already_exists_and_keeps_its_own_files()
    {
        var expected = CreateOld();
        TestFiles.Write(New, @"History\20261101-100000.json", RandomNumberGenerator.GetBytes(400));
        foreach (var (path, hash) in TestFiles.Hashes(New))
            expected.Add(path, hash);
        var files = new TestFolderOperations();

        Assert.True(Move(files));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
        Assert.Equal(0, files.Renames);
    }

    [Fact]
    public void A_copy_that_fails_part_way_deletes_nothing_and_the_next_start_finishes_it()
    {
        var expected = CreateOld();

        Assert.False(Move(new TestFolderOperations { RenameFails = true, FailingFile = "20261001-120000.log" }));

        // The old folder is byte for byte as it was, and nothing of the broken copy is left in the new one.
        Assert.Equal(expected, TestFiles.Hashes(Old));
        Assert.DoesNotContain(TestFiles.Hashes(New).Keys, path => path.StartsWith(@"Logs\", StringComparison.OrdinalIgnoreCase));

        Assert.True(Move(new TestFolderOperations { RenameFails = true }));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
    }

    [Fact]
    public void A_copy_that_does_not_match_is_removed_and_the_old_folder_stays()
    {
        var expected = CreateOld();

        Assert.False(Move(new TestFolderOperations { RenameFails = true, CorruptedFile = "Setup-2.0.0.exe" }));

        Assert.Equal(expected, TestFiles.Hashes(Old));
        Assert.False(File.Exists(Path.Combine(New, @"Updates\Setup-2.0.0.exe")));

        Assert.True(Move(new TestFolderOperations { RenameFails = true }));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
    }

    [Fact]
    public void A_file_the_new_folder_already_has_wins_and_the_old_folder_stays()
    {
        var expected = CreateOld();
        TestFiles.Write(New, @"History\20261001-120000.json", RandomNumberGenerator.GetBytes(50));
        var theirs = TestFiles.Hashes(New)[@"History\20261001-120000.json"];

        Assert.False(Move());

        Assert.Equal(theirs, TestFiles.Hashes(New)[@"History\20261001-120000.json"]);
        Assert.Equal(expected, TestFiles.Hashes(Old));
        Assert.Equal(expected[@"Logs\20261001-120000.log"], TestFiles.Hashes(New).GetValueOrDefault(@"Logs\20261001-120000.log"));
    }

    [Fact]
    public void Continues_a_run_that_stopped_while_copying()
    {
        var expected = CreateOld();
        File.Copy(Path.Combine(Old, Layout[0].Path), Path.Combine(Directory.CreateDirectory(Path.Combine(New, "History")).FullName, Path.GetFileName(Layout[0].Path)));
        var partial = Path.Combine(New, @"History\20261002-090000.json" + DataFolderMove.PartialSuffix);
        File.WriteAllBytes(partial, [1, 2, 3]);
        var files = new TestFolderOperations();

        Assert.True(Move(files));

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
        Assert.Equal(Layout.Length - 1, files.Copies);
    }

    [Fact]
    public void Continues_a_run_that_stopped_while_removing_the_old_files()
    {
        var expected = CreateOld();
        foreach (var (path, _) in Layout)
            TestFiles.Write(New, path, File.ReadAllBytes(Path.Combine(Old, path)));
        File.Delete(Path.Combine(Old, Layout[0].Path));
        File.Delete(Path.Combine(Old, Layout[2].Path));

        Assert.True(Move());

        Assert.Equal(expected, TestFiles.Hashes(New));
        Assert.False(Directory.Exists(Old));
    }

    [Theory]
    [InlineData("old folder")]
    [InlineData("inside the old folder")]
    [InlineData("new folder")]
    [InlineData("inside the new folder")]
    public void Refuses_a_link_and_changes_nothing(string where)
    {
        TestFiles.Write(Outside, "keep.txt", RandomNumberGenerator.GetBytes(100));
        var outside = TestFiles.Hashes(Outside);
        SortedDictionary<string, string> expected;
        if (where == "old folder")
        {
            TestFiles.CreateJunction(Old, Outside);
            expected = TestFiles.Hashes(Old);
        }
        else
        {
            expected = CreateOld();
            if (where == "inside the old folder")
            {
                TestFiles.CreateJunction(Path.Combine(Old, @"Logs\link"), Outside);
                expected = TestFiles.Hashes(Old);
            }
            else if (where == "new folder")
                TestFiles.CreateJunction(New, Outside);
            else
                TestFiles.CreateJunction(Path.Combine(New, "link"), Outside);
        }

        Assert.NotEmpty(expected);

        Assert.False(Move(new TestFolderOperations { RenameFails = true }));

        Assert.Equal(expected, TestFiles.Hashes(Old));
        Assert.Equal(outside, TestFiles.Hashes(Outside));
        if (where is "old folder" or "inside the old folder")
            Assert.False(Directory.Exists(New));
    }

    [Fact]
    public void Moves_an_empty_old_folder_when_the_rename_fails()
    {
        Directory.CreateDirectory(Old);

        Assert.True(Move(new TestFolderOperations { RenameFails = true }));

        Assert.True(Directory.Exists(New));
        Assert.False(Directory.Exists(Old));
    }

    [Fact]
    public void Does_nothing_when_there_is_no_old_folder()
    {
        var files = new TestFolderOperations();

        Assert.True(Move(files));

        Assert.False(Directory.Exists(New));
        Assert.Equal((0, 0), (files.Renames, files.Copies));
    }

    [Fact]
    public void RemoveTree_deletes_the_folder_and_everything_in_it()
    {
        CreateOld();

        Assert.True(DataFolderMove.RemoveTree(Old));

        Assert.False(Directory.Exists(Old));
    }

    [Fact]
    public void RemoveTree_never_follows_or_deletes_a_link()
    {
        CreateOld();
        TestFiles.Write(Outside, "keep.txt", RandomNumberGenerator.GetBytes(100));
        var outside = TestFiles.Hashes(Outside);
        TestFiles.CreateJunction(Path.Combine(Old, @"Logs\link"), Outside);

        Assert.False(DataFolderMove.RemoveTree(Old));

        Assert.Equal(outside, TestFiles.Hashes(Outside));
        Assert.True(Directory.Exists(Path.Combine(Old, @"Logs\link")));
        Assert.False(Directory.Exists(Path.Combine(Old, "History")));
        Assert.False(File.Exists(Path.Combine(Old, Layout[2].Path)));
    }
}
