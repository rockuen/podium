// @module handlers/desktopNotification — cross-platform OS toast.
// Windows: Win10+ toast via PowerShell + WinRT. macOS: osascript display notification.
// Linux: not implemented (no-op).

function showDesktopNotification(tabTitle) {
  const { execFile } = require('child_process');
  const msg = (tabTitle || 'Claude Code').replace(/[^a-zA-Z0-9가-힣ㄱ-ㅎㅏ-ㅣ\s\-_]/g, '');
  if (process.platform === 'win32') {
    const psCmd = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null;',
      '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
      '$n = $t.GetElementsByTagName("text");',
      "$n.Item(0).AppendChild($t.CreateTextNode('Claude Code')) | Out-Null;",
      "$n.Item(1).AppendChild($t.CreateTextNode('" + msg.replace(/'/g, "''") + "')) | Out-Null;",
      '$toast = [Windows.UI.Notifications.ToastNotification]::new($t);',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Claude Code").Show($toast)'
    ].join(' ');
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd], { timeout: 5000 }, () => {});
  } else if (process.platform === 'darwin') {
    const escaped = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execFile('osascript', ['-e', `display notification "${escaped}" with title "Claude Code"`], { timeout: 5000 }, () => {});
  }
}

module.exports = { showDesktopNotification };
