# Folder picker for Claudia, run by the server on the user's own machine.
# Must be invoked with -STA: shell dialogs require a single-threaded apartment.
# Prints the chosen path on stdout, or nothing if cancelled.
#
# Uses the Vista+ Common Item Dialog (IFileOpenDialog with FOS_PICKFOLDERS) —
# the modern Explorer-style picker with a shortcuts sidebar, address bar and a
# real browsing pane. Windows PowerShell 5.1 runs on .NET Framework, where
# System.Windows.Forms.FolderBrowserDialog is always the old expandable-tree
# widget; only .NET Core 3+ upgrades it automatically, and PowerShell 7 is not
# installed here, so the interface is bound directly.
#
# All COM work happens in C#. PowerShell's cast operator does not perform a COM
# QueryInterface, so casting the coclass to its interface fails there; in C# the
# same cast is a real QI.
#
# Unused vtable slots are declared as no-arg placeholders: COM dispatch is by
# slot order, so every method must be present and in order, but signatures only
# matter for methods actually called.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace ClaudiaPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
  public class FileOpenDialogCoClass { }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler();
    void GetParent();
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes();
    void Compare();
  }

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes();
    void SetFileTypeIndex();
    void GetFileTypeIndex();
    void Advise();
    void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel();
    void GetResult(out IShellItem ppsi);
  }

  public static class Picker {
    const uint FOS_PICKFOLDERS = 0x00000020;
    const uint FOS_FORCEFILESYSTEM = 0x00000040;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int S_OK = 0;

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern IShellItem SHCreateItemFromParsingName(
      string path, IntPtr bc, [In] ref Guid riid);

    /// <summary>Chosen folder, or null if the user cancelled.</summary>
    public static string Choose(IntPtr owner, string startPath) {
      // This cast is the QueryInterface that PowerShell cannot do.
      IFileDialog dialog = (IFileDialog)(new FileOpenDialogCoClass());
      try {
        dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
        dialog.SetTitle("Select a working directory for Claudia");
        dialog.SetOkButtonLabel("Use this folder");

        if (!string.IsNullOrEmpty(startPath)) {
          try {
            Guid iid = typeof(IShellItem).GUID;
            dialog.SetFolder(SHCreateItemFromParsingName(startPath, IntPtr.Zero, ref iid));
          } catch {
            // A missing or unreadable start folder is not worth failing over.
          }
        }

        if (dialog.Show(owner) != S_OK) return null;   // cancelled

        IShellItem item;
        dialog.GetResult(out item);
        string path;
        item.GetDisplayName(SIGDN_FILESYSPATH, out path);
        Marshal.ReleaseComObject(item);
        return path;
      } finally {
        Marshal.ReleaseComObject(dialog);
      }
    }
  }
}
'@

# A 1px, taskbar-less, always-on-top form. Its only job is to own the dialog and
# pull it in front: shown ownerless from a background server process the dialog
# opens *behind* the browser, so Browse looks like it did nothing at all.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Show()
$owner.Activate()
[void][ClaudiaPicker.Picker]::BringWindowToTop($owner.Handle)
[void][ClaudiaPicker.Picker]::SetForegroundWindow($owner.Handle)
[System.Windows.Forms.Application]::DoEvents()

try {
  $start = if ($args.Count -ge 1) { $args[0] } else { '' }
  $chosen = [ClaudiaPicker.Picker]::Choose($owner.Handle, $start)
  if ($chosen) { Write-Output $chosen }
} finally {
  $owner.Close()
}
