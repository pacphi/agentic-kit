<#
    agentic-kit — Windows host-process survey.

    The POSIX runtime survey shells out to `ps` and `lsof`; Windows has no
    equivalent single binary, so this script is that binary's stand-in. It is
    plain text, invoked with -File exactly the way `ps` is invoked with argv:
    nothing here is compiled, installed, or persisted, and it takes no npm
    dependency.

    Three modes, deliberately separated so the privacy-sensitive read and the
    fragile read are each isolated from the guaranteed floor:

      -Mode census                 every process's pid, ppid, start time, image
                                   name, CPU time and working set. No command
                                   lines. This is the GUARANTEED floor: if the
                                   two modes below fail entirely, the caller
                                   still has a complete resource census.
      -Mode commands -ProcessIds   command line for the named pids, and ONLY
                                   for pids the current user actually owns.
                                   Ownership is proven with GetOwner, never
                                   assumed from session id — a process we
                                   cannot attribute is reported as such, never
                                   silently included.
      -Mode cwd -ProcessIds        best-effort true working directory, read out
                                   of each process's PEB. This is the only part
                                   that can fail for environmental reasons (AV
                                   blocking Add-Type, constrained language mode,
                                   access denied, bitness mismatch) and every
                                   one of those failures is reported per-pid as
                                   an `err` row rather than raised — the caller
                                   must be able to keep the census when this
                                   mode returns nothing useful.

    Every mode emits tab-separated lines and exits 0. Tabs and newlines are
    stripped out of command lines before emission so a row is always one line
    with a fixed field count.
#>
[CmdletBinding()]
param(
    [ValidateSet('census', 'commands', 'cwd')]
    [string]$Mode = 'census',

    # Comma-separated decimal pids. The caller already numeric-coerces these;
    # the regex below is the second guard, so nothing user-shaped can reach a
    # WQL filter or a P/Invoke call.
    [string]$ProcessIds = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-RequestedIds {
    param([string]$Raw)
    $ids = @()
    foreach ($part in ($Raw -split ',')) {
        $trimmed = $part.Trim()
        if ($trimmed -match '^\d+$') { $ids += [int]$trimmed }
    }
    return $ids
}

if ($Mode -eq 'census') {
    # CommandLine is deliberately absent from this projection: it is the one
    # field that can hold a pasted prompt or a token, and the floor never
    # needs it.
    $props = @(
        'ProcessId', 'ParentProcessId', 'Name', 'CreationDate',
        'KernelModeTime', 'UserModeTime', 'WorkingSetSize'
    )
    foreach ($proc in (Get-CimInstance -ClassName Win32_Process -Property $props)) {
        $created = ''
        if ($proc.CreationDate) {
            $created = ([datetime]$proc.CreationDate).ToUniversalTime().ToString('yyyy-MM-dd\THH:mm:ss\Z')
        }
        $cpu = [uint64]0
        if ($proc.KernelModeTime) { $cpu = $cpu + [uint64]$proc.KernelModeTime }
        if ($proc.UserModeTime) { $cpu = $cpu + [uint64]$proc.UserModeTime }
        $rss = [uint64]0
        if ($proc.WorkingSetSize) { $rss = [uint64]$proc.WorkingSetSize }
        $name = ([string]$proc.Name) -replace '\s+', '_'
        "$($proc.ProcessId)`t$($proc.ParentProcessId)`t$created`t$name`t$cpu`t$rss"
    }
    exit 0
}

if ($Mode -eq 'commands') {
    $ids = Get-RequestedIds -Raw $ProcessIds
    if ($ids.Count -eq 0) { exit 0 }
    $filter = (($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR ')
    $me = [string]$env:USERNAME
    foreach ($proc in (Get-CimInstance -ClassName Win32_Process -Filter $filter)) {
        $owner = $null
        try { $owner = Invoke-CimMethod -InputObject $proc -MethodName GetOwner -ErrorAction Stop }
        catch { $owner = $null }
        if (-not $owner -or $owner.ReturnValue -ne 0) {
            # Unattributable, not foreign — the caller must be able to tell the
            # difference between "someone else's process" and "we could not ask".
            "$($proc.ProcessId)`terr`towner-probe-failed"
            continue
        }
        if ([string]$owner.User -ne $me) {
            "$($proc.ProcessId)`tother`t"
            continue
        }
        $commandLine = ([string]$proc.CommandLine) -replace '[\r\n\t]+', ' '
        "$($proc.ProcessId)`town`t$commandLine"
    }
    exit 0
}

# -Mode cwd. Windows exposes no supported API for another process's current
# directory, so this walks the documented layout the debugger tooling walks:
# NtQueryInformationProcess -> PEB -> RTL_USER_PROCESS_PARAMETERS ->
# CurrentDirectory.DosPath, reading each hop with ReadProcessMemory. The offsets
# below are the 64-bit-process layout only; a bitness mismatch between this
# reader and the target is DETECTED and reported, never read through with the
# wrong offsets, because a plausible-looking wrong path is worse than no path.
$ids = Get-RequestedIds -Raw $ProcessIds
if ($ids.Count -eq 0) { exit 0 }

$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class AkProcessCwd
{
    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass,
        ref PROCESS_BASIC_INFORMATION info, int length, out int written);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass,
        out IntPtr info, int length, out int written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadProcessMemory(IntPtr handle, IntPtr address,
        byte[] buffer, IntPtr size, out IntPtr read);

    private const int ProcessBasicInformation = 0;
    private const int ProcessWow64Information = 26;

    // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ. Deliberately not
    // PROCESS_ALL_ACCESS: this probe reads six pointers and one string.
    private const int Access = 0x1000 | 0x0010;

    private const long PebProcessParameters = 0x20;
    private const long ParametersCurrentDirectory = 0x38;

    private static IntPtr Offset(IntPtr basePtr, long delta)
    {
        return new IntPtr(basePtr.ToInt64() + delta);
    }

    private static byte[] ReadBytes(IntPtr handle, IntPtr address, int size)
    {
        byte[] buffer = new byte[size];
        IntPtr read;
        if (!ReadProcessMemory(handle, address, buffer, new IntPtr(size), out read)) { return null; }
        if (read.ToInt64() != size) { return null; }
        return buffer;
    }

    public static string Read(int pid)
    {
        if (IntPtr.Size != 8) { return "err\treader-not-64bit"; }
        IntPtr handle = OpenProcess(Access, false, pid);
        if (handle == IntPtr.Zero) { return "err\topen-denied"; }
        try
        {
            IntPtr wow64 = IntPtr.Zero;
            int written;
            int wowStatus = NtQueryInformationProcess(handle, ProcessWow64Information,
                out wow64, IntPtr.Size, out written);
            if (wowStatus == 0 && wow64 != IntPtr.Zero) { return "err\twow64-mismatch"; }

            PROCESS_BASIC_INFORMATION info = new PROCESS_BASIC_INFORMATION();
            int status = NtQueryInformationProcess(handle, ProcessBasicInformation,
                ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out written);
            if (status != 0) { return "err\tquery-failed"; }
            if (info.PebBaseAddress == IntPtr.Zero) { return "err\tno-peb"; }

            byte[] pointer = ReadBytes(handle, Offset(info.PebBaseAddress, PebProcessParameters), 8);
            if (pointer == null) { return "err\tpeb-read-failed"; }
            long parameters = BitConverter.ToInt64(pointer, 0);
            if (parameters == 0) { return "err\tno-parameters"; }

            // CurrentDirectory.DosPath is a UNICODE_STRING: Length, MaximumLength,
            // 4 bytes of padding on x64, then the wide-char buffer pointer.
            byte[] header = ReadBytes(handle,
                new IntPtr(parameters + ParametersCurrentDirectory), 16);
            if (header == null) { return "err\tparameters-read-failed"; }
            int length = BitConverter.ToUInt16(header, 0);
            long buffer = BitConverter.ToInt64(header, 8);
            if (length <= 0 || length > 8192 || buffer == 0) { return "err\tempty-cwd"; }

            byte[] raw = ReadBytes(handle, new IntPtr(buffer), length);
            if (raw == null) { return "err\tcwd-read-failed"; }
            string value = Encoding.Unicode.GetString(raw).TrimEnd('\0').Trim();
            if (value.Length == 0) { return "err\tempty-cwd"; }
            value = value.TrimEnd('\\');
            if (value.Length == 2 && value[1] == ':') { value = value + "\\"; }
            if (value.IndexOf('\t') >= 0 || value.IndexOf('\n') >= 0) { return "err\tunexpected-cwd"; }
            return "ok\t" + value;
        }
        catch { return "err\tprobe-failed"; }
        finally { CloseHandle(handle); }
    }
}
'@

$ready = $false
try {
    Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
    $ready = $true
} catch {
    $ready = $false
}

if (-not $ready) {
    # AV interception, constrained language mode, or no in-box compiler. Say so
    # for every pid; the caller keeps its census and drops only the project
    # attribution.
    foreach ($id in $ids) { "$id`terr`tcompile-failed" }
    exit 0
}

foreach ($id in $ids) {
    try { "$id`t$([AkProcessCwd]::Read($id))" }
    catch { "$id`terr`tprobe-failed" }
}
exit 0
