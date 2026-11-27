# Raikasa

Native Windows 11 maintenance utility (WinUI 3). It runs built-in Windows tools (DISM, SFC, chkdsk, cache cleanup,
network resets, Windows Update, winget, Defender) as hidden processes and shows everything in the GUI. The design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

```powershell
dotnet test --project tests/Raikasa.Core.Tests              # unit tests (Microsoft.Testing.Platform, xUnit v3)
dotnet build src/Raikasa -c Release -p:Platform=x64         # WinUI projects need an explicit Platform
dotnet run --project src/Raikasa -p:Platform=x64
dotnet format Raikasa.slnx --verify-no-changes              # the CI lint step
.\build.ps1                                                 # tests, publish, licenses, installer
```

## Layout

- `src/Raikasa.Core`: all logic, no UI. Tools (`Tools/`), the catalog (`Catalog/ToolCatalog.cs`), process runner
  and Windows helpers (`Platform/`), known issues and the LLM report (`Diagnostics/`), run engine and history
  (`Engine/`), elevated worker protocol (`Worker/`), PowerShell scripts embedded as resources (`Scripts/`).
- `src/Raikasa`: WinUI 3 app. `Program.cs` also dispatches `--worker`, `--reminder` and `--uninstall`.
- `tests/Raikasa.Core.Tests`: unit tests. None of them change the system, so CI runs them all. Tools that need
  administrator rights are verified by hand (README, *Verifying the administrator tools*).

## Rules

- English only: code, UI text, docs, commits.
- The product name is spelled once in `Directory.Build.props` (`ProductName`, which the project names, the installer and
  `build.ps1` follow) and once in C# (`src/Raikasa.Core/ProductInfo.cs`, which every runtime id uses). XAML text and
  the documents keep the literal name.
- Never show invented numbers. Only measured values (bytes deleted, updates installed) reach the UI or docs.
- Detection must not depend on localized console text: use exit codes, HRESULTs, `DISM /English`, `CBS.log`, and
  JSON emitted by the PowerShell scripts.
- The elevated worker runs only catalog tools whose context is Admin, with validated options, and starts executables
  by full path. Never pass command lines over the pipe.
- Plain-language copy for every tool: what it does and, for troubleshooting tools, when to use it.
- Git: plain `git commit` with the global identity, no co-author trailers or generated-by footers. Everything green
  before pushing.
