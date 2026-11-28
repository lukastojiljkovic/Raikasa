# Threat model

What the app protects, where it trusts and where it doesn't, and what the tests in this repository check. It describes
the code in this repository today. To report a problem, follow [SECURITY.md](../SECURITY.md).

## Assets

- **The integrity of the user's system.** The app runs repair and cleanup tools, so a flaw in it could change a
  system that the user trusted it with.
- **The elevated execution context.** Some tools need administrator rights. The app runs them in a separate
  administrator helper that starts on the first such step and lasts for the session.
- **The update channel.** The app checks GitHub for a newer release, downloads its installer and starts it.

## Trust boundaries

1. **The window to the administrator helper.** The window runs as the signed-in user. The helper runs as an
   administrator and is started through the normal Windows approval prompt. They talk over a named pipe.
2. **The app to the GitHub release channel.** The release page, the installer and its checksum file come from the
   network.
3. **The cleanup tools to the file system under administrator rights.** Some cleanups delete files that only an
   administrator can delete.

## Threats, by STRIDE category

### Spoofing the other end of the pipe

The window creates the pipe and checks, after the helper connects, that the connecting process is the one it started.
The helper checks in the other direction that the pipe is served by the window that started it. Each side refuses a
peer that isn't the expected process. The pipe also carries an access control list.

### The helper doing more than the user chose

The helper runs only catalog tools whose context is administrator, and it checks the options for each request. A
request for any other tool is refused. The helper starts executables by full path and never by searching `PATH`.
The protocol carries a tool id and validated options, never a command line.

### Tampering on the update channel

The app downloads an installer only from the release's own assets and checks its SHA-256 against the checksum file that
the same release publishes. It refuses a release without a checksum file, a malformed checksum file or a download that
doesn't match, and it deletes a download that fails the check. It checks again that the file didn't change before it
starts it.

Residual risk: a checksum file from the same release proves that the download is intact, not who published it. Someone
who can replace the installer on the release page can replace the checksum file too. Signed checksums are planned for
3.0.0.

## What the tests check

The unit tests in `tests/` cover these points without changing the system they run on:

- the helper runs only administrator tools from the catalog and rejects invalid options;
- a connection from another process is refused, and so is a pipe served by another process;
- executables start from their full path;
- the update check, the checksum file, a corrupted download and a file that changed after the download.

## Stated limits

- Under the legacy Admin Approval Mode, UAC is a defence-in-depth feature, not a security boundary. These checks limit
  what the app's administrator helper does, not what runs on Windows in general.
- The build isn't Authenticode-signed, so Windows SmartScreen may warn. Check the installer's SHA-256 against the
  release notes before you run it.
