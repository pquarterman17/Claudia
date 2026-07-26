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

  [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileOpenDialog {
    // IFileDialog's slots come first: this interface extends it, and COM
    // dispatch is by slot order.
    [PreserveSig] int Show(IntPtr hwndOwner);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
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
    void AddPlace(); void SetDefaultExtension(); void Close(); void SetClientGuid();
    void ClearClientData(); void SetFilter();
    // IFileOpenDialog adds these two.
    void GetResults(out IShellItemArray ppenum);
    void GetSelectedItems(out IShellItemArray ppsai);
  }

  [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItemArray {
    void BindToHandler(); void GetPropertyStore(); void GetPropertyDescriptionList();
    void GetAttributes();
    void GetCount(out uint pdwNumItems);
    void GetItemAt(uint dwIndex, out IShellItem ppsi);
    void EnumItems();
  }

  public static class Picker {
    const uint FOS_PICKFOLDERS = 0x00000020;
    const uint FOS_ALLOWMULTISELECT = 0x00000200;
    const uint FOS_FORCEFILESYSTEM = 0x00000040;
    const uint SIGDN_FILESYSPATH = 0x80058000;
    const int S_OK = 0;

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern IShellItem SHCreateItemFromParsingName(
      string path, IntPtr bc, [In] ref Guid riid);

    /// <summary>
    /// Chosen folders, one per line, or null if cancelled. Multi-select is on,
    /// so ctrl-clicking several repos starts a session in each.
    /// </summary>
    public static string Choose(IntPtr owner, string startPath) {
      // This cast is the QueryInterface that PowerShell cannot do.
      IFileOpenDialog dialog = (IFileOpenDialog)(new FileOpenDialogCoClass());
      try {
        dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_ALLOWMULTISELECT);
        dialog.SetTitle("Select working directories for Claudia (ctrl-click for several)");
        dialog.SetOkButtonLabel("Use these folders");

        if (!string.IsNullOrEmpty(startPath)) {
          try {
            Guid iid = typeof(IShellItem).GUID;
            dialog.SetFolder(SHCreateItemFromParsingName(startPath, IntPtr.Zero, ref iid));
          } catch {
            // A missing or unreadable start folder is not worth failing over.
          }
        }

        if (dialog.Show(owner) != S_OK) return null;   // cancelled

        IShellItemArray items;
        dialog.GetResults(out items);
        uint count;
        items.GetCount(out count);
        var paths = new System.Text.StringBuilder();
        for (uint i = 0; i < count; i++) {
          IShellItem item;
          items.GetItemAt(i, out item);
          string path;
          item.GetDisplayName(SIGDN_FILESYSPATH, out path);
          // (char)10 rather than an escape: this C# lives inside a PowerShell
          // here-string, where a backslash escape is one more thing to get wrong.
          if (paths.Length > 0) paths.Append((char)10);
          paths.Append(path);
          Marshal.ReleaseComObject(item);
        }
        Marshal.ReleaseComObject(items);
        return paths.ToString();
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
